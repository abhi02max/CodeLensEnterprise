"""Bounded internal HTTP transport; timed-out work retains its admission slot."""

import asyncio
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.strict_risk import (
    CONTRACT,
    REQUEST_BYTES,
    PairRequest,
    SafeFailure,
    SingleRequest,
    StrictRegistry,
)

router = APIRouter()
settings = get_settings()
engine = StrictRegistry(
    settings.artifacts_dir,
    settings.org_artifacts_dir,
    os.getenv("ML_RUNTIME_IDENTITY", "local-unattested"),
)
slots = threading.BoundedSemaphore(1)
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="strict-risk")
DEADLINE_SECONDS = 10


def unavailable(category: str, status_code: int = 503):
    return JSONResponse(
        {"status": "UNAVAILABLE", "contractVersion": CONTRACT, "category": category},
        status_code=status_code,
    )


async def handle(request: Request, pair: bool):
    if not slots.acquire(blocking=False):
        return unavailable("BUSY", 429)
    submitted = False
    try:
        data = bytearray()
        async with asyncio.timeout(2):
            async for chunk in request.stream():
                if len(data) + len(chunk) > REQUEST_BYTES:
                    return unavailable("REQUEST_BOUND", 413)
                data.extend(chunk)
        try:
            # Reject duplicate keys and JSON's nonstandard NaN/Infinity tokens.
            def unique(pairs):
                out = {}
                for key, value in pairs:
                    if key in out:
                        raise ValueError()
                    out[key] = value
                return out

            def reject_constant(_):
                raise ValueError()

            raw = json.loads(data, object_pairs_hook=unique, parse_constant=reject_constant)
            parsed = (PairRequest if pair else SingleRequest).model_validate(raw)
        except Exception:
            return unavailable("INVALID_REQUEST", 422)
        future = executor.submit(engine.infer, parsed)
        submitted = True
        future.add_done_callback(lambda _: slots.release())
        wrapped = asyncio.wrap_future(future)
        wrapped.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
        result = await asyncio.wait_for(asyncio.shield(wrapped), DEADLINE_SECONDS)
        return JSONResponse(result)
    except TimeoutError:
        return unavailable("TIMEOUT", 504)
    except SafeFailure as error:
        return unavailable(error.category)
    except Exception:
        return unavailable("INFERENCE_FAILED")
    finally:
        if not submitted:
            slots.release()


@router.post("/internal/risk/v1/pair", include_in_schema=False)
async def pair(request: Request):
    return await handle(request, True)


@router.post("/internal/risk/v1", include_in_schema=False)
async def single(request: Request):
    return await handle(request, False)
