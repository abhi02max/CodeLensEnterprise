-- Runs once on first container start, before any Prisma migration.
-- pgvector powers RAG similarity search; pg_trgm powers the lexical half of
-- hybrid retrieval and fuzzy file-path search.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
