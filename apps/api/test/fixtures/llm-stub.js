#!/usr/bin/env node
/**
 * Local LLM provider stub. A TEST DOUBLE, never part of the product.
 *
 * Speaks the OpenAI chat-completions and embeddings wire format so the real
 * `OpenAiProvider` adapter, the real retry logic, the real JSON extraction, the real Zod
 * validation, the real repair loop, the real evidence filter and the real persistence path all
 * execute unchanged. Point the API at it with:
 *
 *   OPENAI_BASE_URL=http://127.0.0.1:4599/v1
 *   OPENAI_API_KEY=<any non-empty value>
 *
 * It exists because the failure modes that matter most here cannot be produced on demand from a
 * real provider: a rejected API key, a response that is not JSON, a response that is JSON but
 * violates the schema, one that fabricates evidence ids, and one that recommends approval of a
 * change with a CRITICAL finding. Verifying those against a live model would mean waiting for
 * them to happen by chance.
 *
 * What it does NOT establish: that a real model produces a *good* review. That requires a real
 * key and a human reading the output. See the AI review section of apps/api/README.md.
 *
 * Scenario is switched at runtime:  POST /__scenario  { "scenario": "valid" }
 * Call log:                         GET  /__calls
 */

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.LLM_STUB_PORT ?? 4599);
const EMBEDDING_DIMENSIONS = Number(process.env.LLM_STUB_DIMENSIONS ?? 1536);

let scenario = 'valid';
/** Per-scenario call counter, so a scenario can behave differently on the repair attempt. */
let callCount = 0;
const calls = [];

// ---------------------------------------------------------------- review builders

/**
 * Tool run ids the prompt offered for citation.
 *
 * The prompt renders them as `  <tool> → "<id>"`, so parsing them here is exactly what a
 * compliant model does. Extracting them from the prompt rather than hardcoding them is what
 * makes the "valid" and "fabricated-evidence" scenarios a genuine contrast.
 */
function evidenceIdsFromPrompt(text) {
  const ids = [];
  const pattern = /^\s{2}(\S+)\s+→\s+"([^"]+)"$/gm;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    ids.push({ tool: match[1], id: match[2] });
  }

  return ids;
}

/**
 * Paths and line numbers the prompt mentions, split by where they came from.
 *
 * `flagged` are the static analyzers' own findings, taken from the EVIDENCE section's
 * `<path>:<line> — <message>` lines, so each carries a line as well as a path. `changed` are every
 * file in the DIFF section, rendered as `--- <path> (<status>, <language>, +n/-m)`.
 *
 * The split matters for realism. A compliant model anchors a security finding to the file *and the
 * line* the analyzer flagged, not to whichever changed file happens to sort first and a line it
 * invented. Anchoring to the diff order put a SQL-injection finding on `issue-refund.dto.ts`, and an
 * earlier loose regex put it on `decimal.js` — picked out of the commit message "chore: bump
 * decimal.js". The line was hardcoded to 60, which stayed plausible only until the fixture's hunk
 * grew and the real call moved to 69. All of them looked like product bugs in a screenshot review.
 */
function pathsFromPrompt(text) {
  const flagged = [];
  const changed = new Set();

  let match;

  const findingPattern = /^\s{4}([\w.-]+\/[\w./-]+):(\d+)\s+—/gm;
  while ((match = findingPattern.exec(text)) !== null) {
    flagged.push({ path: match[1], line: Number(match[2]) });
  }

  const diffPattern = /^---\s+(\S+)\s+\(/gm;
  while ((match = diffPattern.exec(text)) !== null) changed.add(match[1]);

  // Loose fallback, restricted to paths containing a directory separator so a bare dependency
  // name in prose cannot be mistaken for a source file.
  if (flagged.length === 0 && changed.size === 0) {
    const loose = text.match(/[\w.-]+\/[\w./-]+\.(?:ts|tsx|js|json|sql|py)/g) ?? [];
    for (const path of loose.slice(0, 6)) changed.add(path);
  }

  return { flagged, changed: [...changed] };
}

function baseReview(prompt, overrides = {}) {
  const evidence = evidenceIdsFromPrompt(prompt);
  const staticRun = evidence.find((entry) => entry.tool.includes('static')) ?? evidence[0];
  const { flagged, changed } = pathsFromPrompt(prompt);

  // The most severe thing the analyzers reported, which is what the review should lead on. The
  // EVIDENCE section is ordered by severity, so the first entry is it.
  const leadFinding = flagged[0];

  const flaggedPaths = [...new Set(flagged.map((entry) => entry.path))];

  // Analyzer-flagged files first, then the rest of the diff. Only the first three are explained,
  // and diff order alone put `package.json` and a migration ahead of the file every finding is
  // in, so the file-by-file section omitted the one file a reviewer cares about.
  const paths = [...flaggedPaths, ...changed.filter((path) => !flaggedPaths.includes(path))];

  // A finding is anchored to the file and line an analyzer actually reported, when one exists.
  const primary =
    leadFinding?.path ??
    changed.find((path) => /^src\/.*\.(ts|tsx|js)$/.test(path)) ??
    changed[0] ??
    'src/payments/refund.service.ts';

  const primaryLine = leadFinding?.line ?? null;

  return {
    executiveSummary:
      'This change allows refunds to exceed the original charge and removes the guard that ' +
      'prevented double refunds. It introduces a raw SQL statement built by string ' +
      'interpolation, which is exploitable, and it ships without tests.',
    technicalSummary:
      'The already-refunded guard in issueRefund is now conditional on a request-supplied ' +
      'allowOvercredit flag, so a caller can bypass it. The ledger update was rewritten as ' +
      '$executeRawUnsafe with interpolated values, bypassing both parameterisation and the ' +
      'tenant-scoping layer. A migration adds the supporting column.',
    approvalRecommendation: 'REQUEST_CHANGES',
    confidence: 0.82,
    recommendationRationale:
      'A client-controlled authorization flag and an interpolated SQL statement in the payment ' +
      'path are both blocking issues.',
    beginnerExplanation:
      'A refund is money going back to a customer. This change lets the caller ask for more ' +
      'money back than was originally charged, and it builds a database command by gluing text ' +
      'together, which lets a caller change what that command does.',
    fileExplanations: paths.slice(0, 3).map((path) => ({
      path,
      whatChanged: `Modified ${path} as part of the overcredit feature.`,
      whyItMatters:
        'This file is on the payment path, where a defect has direct financial impact and is ' +
        'hard to reverse once money has moved.',
      concerns: ['No accompanying test covers the new behaviour'],
      relatedContextPaths: ['src/payments/refund.service.test.ts', 'docs/architecture.md'],
    })),
    findings: [
      {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'Raw SQL built by string interpolation in the refund path',
        explanation:
          'The ledger update is assembled with $executeRawUnsafe and interpolated values, so a ' +
          'value that reaches it can alter the statement. Use a parameterised query.',
        path: primary,
        line: primaryLine,
        suggestedFix:
          'await this.db.$executeRaw`UPDATE charges SET refunded_cents = ${amount} WHERE id = ${id} AND organization_id = ${orgId}`;',
        evidence: staticRun ? [staticRun.id] : [],
        confidence: 0.9,
      },
      {
        category: 'TESTING',
        severity: 'MEDIUM',
        title: 'No test covers overcrediting',
        explanation:
          'The existing suite asserts that double refunds are rejected. Nothing covers the new ' +
          'allowOvercredit path, so the guard could be removed entirely without a failure.',
        path: primary,
        line: null,
        suggestedFix: null,
        evidence: [],
        confidence: 0.75,
      },
    ],
    missingTests: [
      'A refund larger than the original charge when allowOvercredit is set',
      'A refund request where allowOvercredit is supplied by an untrusted caller',
    ],
    suggestedTestCases: [
      {
        description: 'Rejects an overcredit when the caller is not authorised to grant one',
        path: 'src/payments/refund.service.test.ts',
        code:
          "it('rejects unauthorised overcredit', async () => {\n" +
          "  const charge = buildCharge({ amountCents: 1000, refundedCents: 1000 });\n" +
          '  charges.findById.mockResolvedValue(charge);\n\n' +
          "  const result = await service.issueRefund({ chargeId: charge.id, amountCents: 500, allowOvercredit: true });\n\n" +
          '  expect(result.ok).toBe(false);\n' +
          "  expect(result.error.code).toBe('NOT_AUTHORISED');\n" +
          '});',
        rationale: 'Pins the authorization decision to server-side state rather than request input.',
        priority: 'HIGH',
      },
    ],
    reviewerChecklist: [
      {
        item: 'No secrets, tokens or credentials in the diff',
        rationale: 'Required by organization policy on every review.',
        fromPolicy: true,
        status: 'LIKELY_SATISFIED',
      },
      {
        item: 'Tests cover the new behaviour',
        rationale: 'No test file changed while behaviour did.',
        fromPolicy: true,
        status: 'NEEDS_ATTENTION',
      },
      {
        item: 'The overcredit ceiling is enforced somewhere',
        rationale: 'The diff removes the only guard without adding a replacement.',
        fromPolicy: false,
        status: 'NEEDS_ATTENTION',
      },
    ],
    openQuestions: [
      'Is there an upper bound on goodwill credits, and where is it meant to be enforced?',
    ],
    ...overrides,
  };
}

/** Only the fields the reduce step of a map-reduce review asks for. */
function synthesisOnly(review) {
  return {
    executiveSummary: review.executiveSummary,
    technicalSummary: review.technicalSummary,
    approvalRecommendation: review.approvalRecommendation,
    confidence: review.confidence,
    recommendationRationale: review.recommendationRationale,
    beginnerExplanation: review.beginnerExplanation,
    reviewerChecklist: review.reviewerChecklist,
    openQuestions: review.openQuestions,
    suggestedTestCases: review.suggestedTestCases,
  };
}

/** Test-suggestion calls ask for a single field. Detected from the prompt. */
function isTestSuggestionRequest(prompt) {
  return /suggestedTestCases/.test(prompt) && !/executiveSummary/.test(prompt);
}

function isFileBatchRequest(prompt) {
  return /fileExplanations\[\]/.test(prompt) && !/executiveSummary/.test(prompt);
}

// ---------------------------------------------------------------- scenarios

function completionBody(prompt) {
  callCount += 1;
  const attempt = callCount;

  if (isTestSuggestionRequest(prompt)) {
    return { kind: 'json', value: { suggestedTestCases: baseReview(prompt).suggestedTestCases } };
  }

  if (isFileBatchRequest(prompt)) {
    const review = baseReview(prompt);
    return {
      kind: 'json',
      value: {
        fileExplanations: review.fileExplanations,
        findings: review.findings,
        missingTests: review.missingTests,
      },
    };
  }

  switch (scenario) {
    case 'valid':
      return { kind: 'json', value: baseReview(prompt) };

    case 'fabricated-evidence':
      // A plausible-looking id that was never issued. The evidence filter must drop the
      // finding rather than trusting the citation.
      return {
        kind: 'json',
        value: baseReview(prompt, {
          findings: baseReview(prompt).findings.map((finding) =>
            finding.category === 'SECURITY'
              ? { ...finding, evidence: ['cmufabricated000000000000'] }
              : finding,
          ),
        }),
      };

    case 'uncited-critical':
      return {
        kind: 'json',
        value: baseReview(prompt, {
          findings: baseReview(prompt).findings.map((finding) =>
            finding.category === 'SECURITY' ? { ...finding, evidence: [] } : finding,
          ),
        }),
      };

    case 'approve-despite-critical':
      // Policy reconciliation must override this to REQUEST_CHANGES.
      return {
        kind: 'json',
        value: baseReview(prompt, {
          approvalRecommendation: 'APPROVE',
          recommendationRationale: 'Looks fine to me, the refund flow is clearer now.',
        }),
      };

    case 'malformed':
      // Not JSON, on both the first attempt and the repair.
      return {
        kind: 'raw',
        value:
          'Sure! Here is my review of this pull request:\n\n' +
          '1. The refund guard was removed, which is risky.\n' +
          '2. I would add a test.\n\nLet me know if you want more detail.',
      };

    case 'schema-invalid':
      // Valid JSON, wrong shape: required narrative fields absent, enum value invented.
      return {
        kind: 'json',
        value: {
          summary: 'short',
          verdict: 'SHIP_IT',
          issues: ['sql injection'],
        },
      };

    case 'repairable':
      // Fails once, then complies. Exercises the single repair attempt.
      return attempt === 1
        ? { kind: 'raw', value: 'Here is the review: (I forgot the JSON)' }
        : { kind: 'json', value: baseReview(prompt) };

    case 'oversized-usage':
      // Schema-valid, but reports token usage whose cost exceeds the per-run budget.
      return { kind: 'json', value: baseReview(prompt), usage: { prompt: 90_000_000, completion: 20_000_000 } };

    default:
      return { kind: 'json', value: baseReview(prompt) };
  }
}

const HTTP_FAILURE_SCENARIOS = {
  unauthorized: {
    status: 401,
    body: {
      error: {
        // Deliberately echoes prompt-like content, to prove the API does not forward it.
        message:
          'Incorrect API key provided: sk-live-REDACTME. Your request contained the following ' +
          'prompt: "FILE: src/payments/refund.service.ts ... internal system prompt text ..."',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    },
  },
  'model-not-found': {
    status: 404,
    body: { error: { message: 'The model does not exist', type: 'invalid_request_error', code: 'model_not_found' } },
  },
  'rate-limited': {
    status: 429,
    body: { error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } },
  },
  'provider-down': {
    status: 503,
    body: { error: { message: 'The engine is overloaded', type: 'server_error', code: 'engine_overloaded' } },
  },
  'context-too-long': {
    status: 400,
    body: {
      error: {
        message:
          "This model's maximum context length is 128000 tokens, however your messages resulted " +
          'in 190210 tokens. Offending content: FILE: src/payments/refund.service.ts',
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    },
  },
};

// ---------------------------------------------------------------- server

function deterministicEmbedding(text) {
  // Same text must give the same vector, or the content-hash embedding cache behaves
  // differently from production. Not semantically meaningful, and not claimed to be.
  const seed = crypto.createHash('sha256').update(text).digest();
  const vector = new Array(EMBEDDING_DIMENSIONS);

  let x = seed.readUInt32BE(0) || 1;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    vector[i] = (x / 0xffffffff) * 2 - 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  // ---- control plane
  if (url.pathname === '/__scenario' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    scenario = body.scenario ?? 'valid';
    callCount = 0;
    calls.length = 0;
    console.log(`[llm-stub] scenario -> ${scenario}`);
    return json(response, 200, { scenario });
  }

  if (url.pathname === '/__calls') {
    return json(response, 200, { scenario, callCount, calls });
  }

  if (url.pathname === '/__health') {
    return json(response, 200, { ok: true, scenario });
  }

  // ---- embeddings
  if (url.pathname === '/v1/embeddings' && request.method === 'POST') {
    const payload = JSON.parse((await readBody(request)) || '{}');
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ''];

    return json(response, 200, {
      object: 'list',
      model: payload.model ?? 'text-embedding-3-small',
      data: inputs.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: deterministicEmbedding(String(text)),
      })),
      usage: { prompt_tokens: inputs.length * 10, total_tokens: inputs.length * 10 },
    });
  }

  // ---- chat completions
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    const rawBody = await readBody(request);
    const payload = JSON.parse(rawBody || '{}');
    const prompt = (payload.messages ?? []).map((message) => message.content).join('\n\n');

    const authorization = request.headers.authorization ?? '';

    // Matches the wording of buildRepairMessages in packages/ai-agent/src/prompts.ts.
    const isRepair = /Your response failed schema validation/i.test(prompt);

    // `generate_test_suggestions` is a separate tool that makes its own provider call, so a
    // test counting calls has to be able to exclude it.
    const kind = isRepair
      ? 'repair'
      : isTestSuggestionRequest(prompt)
        ? 'test-suggestions'
        : isFileBatchRequest(prompt)
          ? 'file-batch'
          : 'review';

    calls.push({
      at: new Date().toISOString(),
      scenario,
      kind,
      model: payload.model,
      jsonMode: Boolean(payload.response_format),
      messageCount: (payload.messages ?? []).length,
      promptChars: prompt.length,
      // Recorded so a test can assert the key actually travelled, without logging it.
      authorizationPresent: authorization.startsWith('Bearer ') && authorization.length > 10,
      isRepair,
    });

    const failure = HTTP_FAILURE_SCENARIOS[scenario];
    if (failure) {
      console.log(`[llm-stub] responding ${failure.status} for scenario ${scenario}`);
      return json(response, failure.status, failure.body);
    }

    if (scenario === 'hang') {
      console.log('[llm-stub] hanging, never responding');
      return; // Socket stays open until the client aborts.
    }

    const result = completionBody(prompt);
    const content = result.kind === 'json' ? JSON.stringify(result.value) : result.value;
    const usage = result.usage ?? { prompt: Math.ceil(prompt.length / 4), completion: Math.ceil(content.length / 4) };

    return json(response, 200, {
      id: `chatcmpl-stub-${calls.length}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model ?? 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    });
  }

  json(response, 404, { error: { message: `stub has no route for ${request.method} ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[llm-stub] listening on http://127.0.0.1:${PORT}/v1  scenario=${scenario}`);
});
