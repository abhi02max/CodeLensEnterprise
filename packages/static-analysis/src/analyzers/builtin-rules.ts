/**
 * Built-in Semgrep rules, embedded as a string.
 *
 * Embedded rather than read from `infra/semgrep/rules/` for two reasons. It removes a filesystem
 * dependency, so the package works identically whether it is imported by the API, a worker, a
 * test, or a CLI. And more importantly it means these rules apply with **no network access** —
 * registry rulesets (`p/security-audit`) have to be downloaded, so a network-isolated analyzer
 * sandbox cannot use them, whereas a local rule file always works.
 *
 * These are deliberately high-signal rules covering the mistakes that matter most in a review and
 * that a generic linter will not catch: raw SQL construction, credentials in source, missing
 * tenant scoping, and unvalidated model output. Registry packs still layer on top when the
 * sandbox is allowed network access.
 */
export const BUILTIN_SEMGREP_RULES = `
rules:
  # ---------------------------------------------------------------- injection
  - id: codelens-raw-sql-string-interpolation
    languages: [typescript, javascript]
    severity: ERROR
    metadata:
      category: security
      confidence: HIGH
      impact: HIGH
      cwe: "CWE-89: SQL Injection"
    message: >-
      Raw SQL built with string interpolation. A value concatenated into a query can alter the
      statement, which is SQL injection. Use a parameterized query or the ORM query builder.
    patterns:
      - pattern-either:
          - pattern: $DB.$executeRawUnsafe(...)
          - pattern: $DB.$queryRawUnsafe(...)
          - pattern: $DB.$executeRaw(\`...\${...}...\`)
          - pattern: $DB.$queryRaw(\`...\${...}...\`)
          - pattern: $CONN.query(\`...\${...}...\`)
          - pattern: $CONN.execute(\`...\${...}...\`)

  - id: codelens-raw-sql-without-tenant-scope
    languages: [typescript, javascript]
    severity: ERROR
    metadata:
      category: security
      confidence: HIGH
      impact: HIGH
    message: >-
      A raw SQL statement bypasses the ORM tenant-scoping layer and does not filter on
      organizationId. In a multi-tenant system this is a cross-tenant data access path.
    patterns:
      - pattern-either:
          - pattern: $DB.$executeRawUnsafe(...)
          - pattern: $DB.$queryRawUnsafe(...)
      - pattern-not-regex: (?i)organization_?id

  # ---------------------------------------------------------------- credentials
  - id: codelens-hardcoded-credential
    languages: [typescript, javascript, python, go, java, ruby]
    severity: ERROR
    metadata:
      category: security
      confidence: HIGH
      impact: HIGH
      cwe: "CWE-798: Use of Hard-coded Credentials"
    message: >-
      A credential appears to be hardcoded. Rotate it and load it from configuration; a committed
      secret remains in git history even after it is removed.
    pattern-regex: >-
      (?i)(api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password)\\s*[:=]\\s*["'][A-Za-z0-9/+_=-]{16,}["']

  # ---------------------------------------------------------------- correctness
  - id: codelens-unawaited-promise
    languages: [typescript, javascript]
    severity: WARNING
    metadata:
      category: correctness
      confidence: MEDIUM
    message: >-
      A promise-returning call is not awaited, so a rejection becomes an unhandled rejection and
      the operation may not complete before the function returns.
    patterns:
      - pattern-either:
          - pattern: |
              function $F(...) { ...; $OBJ.$METHOD(...); ... }
      - pattern-inside: |
          async function $F(...) { ... }
      - pattern-not: await $OBJ.$METHOD(...)
      - pattern-not: return $OBJ.$METHOD(...)
      - pattern-not: void $OBJ.$METHOD(...)

  - id: codelens-removed-guard-clause
    languages: [typescript, javascript]
    severity: WARNING
    metadata:
      category: correctness
      confidence: LOW
    message: >-
      A guard condition is gated behind a caller-supplied flag. If that flag arrives from request
      input, the caller can disable the check; derive it from server-side state instead.
    patterns:
      - pattern-either:
          - pattern: if (!$INPUT.$FLAG && ...) { ... }
          - pattern: if ($INPUT.$FLAG || ...) { return; }
      - metavariable-regex:
          metavariable: $INPUT
          regex: (input|body|params|query|req|request|dto)

  # ---------------------------------------------------------------- AI safety
  - id: codelens-unvalidated-model-output
    languages: [typescript, javascript]
    severity: ERROR
    metadata:
      category: security
      confidence: MEDIUM
      impact: MEDIUM
    message: >-
      Language model output is parsed and used without schema validation. Validate it with a
      schema before use, otherwise a hallucinated or malformed field propagates downstream.
    patterns:
      - pattern: JSON.parse($RESPONSE)
      - pattern-not-inside: $SCHEMA.safeParse(...)
      - pattern-not-inside: $SCHEMA.parse(...)
      - pattern-not-inside: try { ... } catch (...) { ... }

  # ---------------------------------------------------------------- dangerous execution
  - id: codelens-shell-injection
    languages: [typescript, javascript, python]
    severity: ERROR
    metadata:
      category: security
      confidence: HIGH
      impact: HIGH
      cwe: "CWE-78: OS Command Injection"
    message: >-
      A shell command is built from interpolated values. Pass arguments as an array with the shell
      disabled so a value cannot become a command.
    pattern-either:
      - pattern: exec(\`...\${...}...\`)
      - pattern: execSync(\`...\${...}...\`)
      - pattern: spawn($CMD, ..., {..., shell: true, ...})
      - pattern: subprocess.run(..., shell=True, ...)

  - id: codelens-eval-of-dynamic-value
    languages: [typescript, javascript, python]
    severity: ERROR
    metadata:
      category: security
      confidence: HIGH
      impact: HIGH
    message: >-
      eval executes arbitrary code. If any part of the input is externally influenced this is
      remote code execution.
    pattern-either:
      - pattern: eval(...)
      - pattern: new Function(...)
`.trimStart();

/** Filename used when the rules are written into the analysis sandbox. */
export const BUILTIN_RULES_FILENAME = '.codelens-semgrep-rules.yml';
