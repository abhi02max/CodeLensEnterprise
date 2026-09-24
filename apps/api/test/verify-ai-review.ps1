# Verification harness for the AI review path.
#
# Expects:
#   - the API on :4000
#   - the LLM stub on :4599 (apps/api/test/fixtures/llm-stub.js) for the enabled-path sections
#
# Usage:  pwsh -File apps/api/test/verify-ai-review.ps1 [-Section all|disabled|enabled|failures]

param([string]$Section = 'all')

$ErrorActionPreference = 'Stop'
$base = 'http://localhost:4000/api/v1'
$stub = 'http://127.0.0.1:4599'
$pass = 0
$fail = 0

function Check($label, $condition, $detail = '') {
  if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
  else { Write-Host "  FAIL  $label $detail" -ForegroundColor Red; $script:fail++ }
}
function Section($name) { Write-Host "`n=== $name ===" -ForegroundColor Cyan }
function StatusOf($err) { $err.Exception.Response.StatusCode.value__ }

function SignIn($email) {
  $r = Invoke-RestMethod -Uri "$base/auth/signin" -Method Post -ContentType 'application/json' `
    -Body (@{ email = $email; password = 'CodeLensDemo2026' } | ConvertTo-Json)
  @{ headers = @{ Authorization = "Bearer $($r.tokens.accessToken)" }; user = $r.user }
}

function SetScenario($name) {
  Invoke-RestMethod -Uri "$stub/__scenario" -Method Post -ContentType 'application/json' `
    -Body (@{ scenario = $name } | ConvertTo-Json) | Out-Null
}

function Analyze($headers, $prId) {
  $r = Invoke-RestMethod -Uri "$base/pull-requests/$prId/analyze" -Method Post -Headers $headers `
    -ContentType 'application/json' -Body (@{ force = $true; sync = $true } | ConvertTo-Json)
  $r
}

$owner = SignIn 'owner@acme.dev'
$prs = Invoke-RestMethod -Uri "$base/pull-requests?page=1&pageSize=10" -Headers $owner.headers
$pr = $prs.items | Where-Object { $_.number -eq 412 } | Select-Object -First 1
$prId = $pr.id

$aiConfigured = ((Invoke-RestMethod -Uri "$base/health" -Headers $owner.headers).checks |
  Where-Object { $_.name -eq 'ai-provider' }).ok
Write-Host "pull request #$($pr.number) = $prId   ai-provider configured: $aiConfigured"

# ============================================================ no provider configured
if ($Section -in @('all', 'disabled')) {
  Section 'No provider key: safe degradation'

  if ($aiConfigured) {
    Write-Host '  SKIP  a provider key is configured; run this section without one' -ForegroundColor Yellow
  } else {
    $r = Analyze $owner.headers $prId
    $a = $r.analysis

    Check 'run completes rather than failing' ($r.status -eq 'COMPLETED') "status=$($r.status)"
    Check 'aiReview is null' ($null -eq $a.aiReview)
    Check 'aiReviewStatus is SKIPPED' ($a.aiReviewStatus.state -eq 'SKIPPED') "state=$($a.aiReviewStatus.state)"
    Check 'skip reason names the missing key' ($a.aiReviewStatus.reason -match 'No API key is configured')
    Check 'skip is reported as not retryable' ($a.aiReviewStatus.retryable -eq $false)
    Check 'AI tool ran and reported SUCCESS-with-skip' (
      ($a.toolRuns | Where-Object { $_.tool -eq 'generate_ai_review' }).status -eq 'SUCCESS')
    Check 'static findings still present' ($a.findings.Count -gt 0) "count=$($a.findings.Count)"
    Check 'ML risk still present' ($a.risk.score -gt 0) "score=$($a.risk.score)"
    Check 'RAG context still present' ($a.ragContext.Count -gt 0) "chunks=$($a.ragContext.Count)"
    Check 'degradation carries the skip reason' (
      ($a.degradation | Where-Object { $_ -match 'No API key is configured' }).Count -ge 1)

    $s = Invoke-RestMethod -Uri "$base/review-sessions/$prId" -Headers $owner.headers
    Check 'workspace still renders' ($s.sessionId -eq $prId)
    Check 'workspace exposes aiReviewStatus' ($s.aiReviewStatus.state -eq 'SKIPPED')
  }
}

# ============================================================ enabled path
if ($Section -in @('all', 'enabled')) {
  Section 'Enabled path: schema-valid review'

  if (-not $aiConfigured) {
    Write-Host '  SKIP  no provider configured; start the API against the stub' -ForegroundColor Yellow
  } else {
    SetScenario 'valid'
    $r = Analyze $owner.headers $prId
    $a = $r.analysis
    $ai = $a.aiReview

    Check 'run completed' ($r.status -eq 'COMPLETED') "status=$($r.status)"
    Check 'AI review tool succeeded' (
      ($a.toolRuns | Where-Object { $_.tool -eq 'generate_ai_review' }).status -eq 'SUCCESS')
    Check 'aiReview persisted and returned' ($null -ne $ai.id) "id=$($ai.id)"
    Check 'aiReviewStatus is GENERATED' ($a.aiReviewStatus.state -eq 'GENERATED')
    Check 'ReviewRun reports the aiReview capability' ($a.run.capabilities.aiReview -eq $true)
    Check 'run token usage recorded' ($a.run.tokenUsage.total -gt 0) "tokens=$($a.run.tokenUsage.total)"
    Check 'no aiReview degradation note' (
      ($a.degradation | Where-Object { $_ -match 'AI review' }).Count -eq 0) "notes=$($a.degradation -join ' | ')"

    Section 'Review content'
    Check 'executive summary' ($ai.executiveSummary.Length -ge 20)
    Check 'technical summary' ($ai.technicalSummary.Length -ge 20)
    Check 'beginner explanation' ($ai.beginnerExplanation.Length -ge 20)
    Check 'recommendation rationale (risk explanation)' ($ai.recommendationRationale.Length -ge 10)
    Check 'model recommendation present' ($null -ne $ai.modelRecommendation) "got=$($ai.modelRecommendation)"
    Check 'effective recommendation present' ($null -ne $ai.effectiveRecommendation)
    Check 'confidence in range' ($ai.confidence -ge 0 -and $ai.confidence -le 1) "c=$($ai.confidence)"
    Check 'file explanations' ($ai.fileExplanations.Count -gt 0) "count=$($ai.fileExplanations.Count)"
    Check 'finding explanations' ($ai.findings.Count -gt 0) "count=$($ai.findings.Count)"
    Check 'missing tests listed' ($ai.missingTests.Count -gt 0)
    Check 'suggested test cases with runnable code' (
      $ai.suggestedTestCases.Count -gt 0 -and $ai.suggestedTestCases[0].code.Length -gt 10)
    Check 'reviewer checklist' ($ai.reviewerChecklist.Count -gt 0) "count=$($ai.reviewerChecklist.Count)"
    Check 'checklist marks policy-sourced items' (
      ($ai.reviewerChecklist | Where-Object { $_.fromPolicy }).Count -gt 0)
    Check 'open questions' ($ai.openQuestions.Count -gt 0)

    Section 'Evidence references'
    $validToolRunIds = $a.toolRuns | Where-Object { $_.status -eq 'SUCCESS' } | ForEach-Object { $_.id }
    $cited = $ai.findings | Where-Object { $_.evidence.Count -gt 0 }
    Check 'at least one finding cites evidence' ($cited.Count -gt 0) "count=$($cited.Count)"
    $allCitationsReal = $true
    foreach ($f in $cited) {
      foreach ($e in $f.evidence) { if ($validToolRunIds -notcontains $e) { $allCitationsReal = $false } }
    }
    Check 'every citation is a real successful ToolRun id' $allCitationsReal
    Check 'file explanations reference RAG context paths' (
      ($ai.fileExplanations | Where-Object { $_.relatedContextPaths.Count -gt 0 }).Count -gt 0)

    Section 'Evidence filtering drops fabricated citations'
    SetScenario 'fabricated-evidence'
    $r2 = Analyze $owner.headers $prId
    $ai2 = $r2.analysis.aiReview
    $sec2 = $ai2.findings | Where-Object { $_.category -eq 'SECURITY' }
    Check 'fabricated SECURITY finding dropped' ($sec2.Count -eq 0) "kept=$($sec2.Count)"
    Check 'dropped count recorded' ($ai2.droppedFindingCount -ge 1) "dropped=$($ai2.droppedFindingCount)"
    Check 'non-evidence-required findings survive' ($ai2.findings.Count -ge 1) "kept=$($ai2.findings.Count)"

    SetScenario 'uncited-critical'
    $r3 = Analyze $owner.headers $prId
    $ai3 = $r3.analysis.aiReview
    Check 'uncited CRITICAL finding dropped' (
      ($ai3.findings | Where-Object { $_.severity -eq 'CRITICAL' }).Count -eq 0)
    Check 'drop recorded for uncited critical' ($ai3.droppedFindingCount -ge 1)

    Section 'Policy reconciliation overrides the model'
    SetScenario 'approve-despite-critical'
    $r4 = Analyze $owner.headers $prId
    $ai4 = $r4.analysis.aiReview
    Check 'model said APPROVE' ($ai4.modelRecommendation -eq 'APPROVE') "got=$($ai4.modelRecommendation)"
    Check 'effective recommendation overridden to REQUEST_CHANGES' (
      $ai4.effectiveRecommendation -eq 'REQUEST_CHANGES') "got=$($ai4.effectiveRecommendation)"
    Check 'override flagged' ($ai4.policyOverridden -eq $true)
    Check 'override reasons given' ($ai4.policyReasons.Count -gt 0) "reasons=$($ai4.policyReasons -join '; ')"

    Section 'Malformed response is repaired once'
    SetScenario 'repairable'
    $r5 = Analyze $owner.headers $prId
    Check 'repair produced a valid review' ($null -ne $r5.analysis.aiReview.id)

    # Asserted from the tool's own output rather than from the fixture's call log, so this
    # measures what the product recorded.
    $aiToolOutput = ($r5.analysis.toolRuns | Where-Object { $_.tool -eq 'generate_ai_review' }).output
    Check 'tool recorded requiredRepair' ($aiToolOutput.requiredRepair -eq $true) "got=$($aiToolOutput.requiredRepair)"

    $stubCalls = Invoke-RestMethod -Uri "$stub/__calls"
    $repairCalls = ($stubCalls.calls | Where-Object { $_.kind -eq 'repair' }).Count
    $reviewCalls = ($stubCalls.calls | Where-Object { $_.kind -eq 'review' }).Count

    Check 'provider saw exactly one repair request' ($repairCalls -eq 1) "repairs=$repairCalls"
    Check 'the review itself was attempted once' ($reviewCalls -eq 1) "reviews=$reviewCalls"
    Check 'every call carried the bearer key' (
      ($stubCalls.calls | Where-Object { -not $_.authorizationPresent }).Count -eq 0)
    Check 'JSON mode requested on every call' (
      ($stubCalls.calls | Where-Object { -not $_.jsonMode }).Count -eq 0)

    Section 'Shared link carries the AI narrative, not internals'
    SetScenario 'valid'
    Analyze $owner.headers $prId | Out-Null
    $link = Invoke-RestMethod -Uri "$base/review-sessions/$prId/share-link" -Method Post -Headers $owner.headers `
      -ContentType 'application/json' -Body (@{ scope = 'FULL'; expiresInHours = 2 } | ConvertTo-Json)
    $shared = Invoke-RestMethod -Uri "$base/review-sessions/share/$($link.token)"

    Check 'shared executive summary present' ($shared.aiReview.executiveSummary.Length -ge 20)
    Check 'shared technical summary present' ($shared.aiReview.technicalSummary.Length -ge 20)
    Check 'shared beginner explanation present' ($shared.aiReview.beginnerExplanation.Length -ge 20)
    Check 'shared recommendation present' ($null -ne $shared.aiReview.effectiveRecommendation)
    Check 'shared checklist present' ($shared.aiReview.reviewerChecklist.Count -gt 0)
    Check 'shared narrative omits raw findings evidence ids' ($null -eq $shared.aiReview.findings)
    Check 'shared payload omits tool runs' ($null -eq $shared.toolRuns)
    Check 'shared payload omits prompt version' ($null -eq $shared.aiReview.promptVersion)
    Check 'shared payload omits token usage' ($null -eq $shared.aiReview.tokenUsage)
    Check 'shared payload omits cost' ($null -eq $shared.aiReview.costCents)
    Check 'shared payload omits provider and model' (
      $null -eq $shared.aiReview.provider -and $null -eq $shared.aiReview.model)

    $sharedJson = $shared | ConvertTo-Json -Depth 14
    Check 'no system prompt text in shared payload' (-not ($sharedJson -match 'You are one part of a larger review system'))
    Check 'no tool run id in shared payload' (-not ($sharedJson -match ($validToolRunIds[0])))

    Section 'Nothing sensitive in the authenticated payload either'
    $full = Invoke-RestMethod -Uri "$base/pull-requests/$prId/analysis" -Headers $owner.headers
    $fullJson = $full | ConvertTo-Json -Depth 14
    Check 'no API key in analysis payload' (-not ($fullJson -match 'sk-'))
    Check 'no system prompt in analysis payload' (-not ($fullJson -match 'You are one part of a larger review system'))
    Check 'no raw provider envelope in analysis payload' (-not ($fullJson -match 'chatcmpl-stub'))

    Section 'Audit trail'
    $logs = Invoke-RestMethod -Uri "$base/audit-logs?resourceType=ReviewRun&page=1&pageSize=10" -Headers $owner.headers
    $completed = $logs.items | Where-Object { $_.action -eq 'review_run.completed' } | Select-Object -First 1
    Check 'review run completion audited' ($null -ne $completed)
    Check 'audit records the aiReview capability' ($completed.metadata.capabilities.aiReview -eq $true) `
      "caps=$($completed.metadata.capabilities | ConvertTo-Json -Compress)"
    Check 'audit records cost' ($null -ne $completed.metadata.costCents)
    $auditJson = $logs | ConvertTo-Json -Depth 10
    Check 'no prompt text in audit metadata' (-not ($auditJson -match 'You are one part of a larger review system'))
  }
}

# ============================================================ failure modes
if ($Section -in @('all', 'failures')) {
  Section 'Provider failures degrade only the AI review'

  if (-not $aiConfigured) {
    Write-Host '  SKIP  no provider configured; start the API against the stub' -ForegroundColor Yellow
  } else {
    $cases = @(
      @{ scenario = 'unauthorized';      state = 'FAILED'; retryable = $false; match = 'API key was rejected' },
      @{ scenario = 'model-not-found';   state = 'FAILED'; retryable = $false; match = 'not available' },
      @{ scenario = 'rate-limited';      state = 'FAILED'; retryable = $true;  match = 'rate-limited' },
      @{ scenario = 'provider-down';     state = 'FAILED'; retryable = $true;  match = 'server error' },
      @{ scenario = 'context-too-long';  state = 'FAILED'; retryable = $false; match = 'context window' },
      @{ scenario = 'malformed';         state = 'FAILED'; retryable = $false; match = 'not valid JSON' },
      @{ scenario = 'schema-invalid';    state = 'FAILED'; retryable = $false; match = 'did not match the required structure' }
    )

    foreach ($case in $cases) {
      SetScenario $case.scenario
      $r = Analyze $owner.headers $prId
      $a = $r.analysis
      $toolRun = $a.toolRuns | Where-Object { $_.tool -eq 'generate_ai_review' }

      Write-Host "`n  -- $($case.scenario)"
      Check "$($case.scenario): run is PARTIAL not FAILED" ($r.status -eq 'PARTIAL') "status=$($r.status)"
      Check "$($case.scenario): AI tool run recorded as failure" ($toolRun.status -in @('FAILED','TIMED_OUT')) "status=$($toolRun.status)"
      Check "$($case.scenario): aiReviewStatus FAILED" ($a.aiReviewStatus.state -eq $case.state) "state=$($a.aiReviewStatus.state)"
      Check "$($case.scenario): reason stored and specific" ($a.aiReviewStatus.reason -match $case.match) "reason=$($a.aiReviewStatus.reason)"
      Check "$($case.scenario): retryable classified" ($a.aiReviewStatus.retryable -eq $case.retryable) "got=$($a.aiReviewStatus.retryable)"
      Check "$($case.scenario): aiReview not persisted" ($null -eq $a.aiReview)
      Check "$($case.scenario): static findings unaffected" ($a.findings.Count -gt 0) "count=$($a.findings.Count)"
      Check "$($case.scenario): ML risk unaffected" ($a.risk.score -gt 0) "score=$($a.risk.score)"
      Check "$($case.scenario): RAG context unaffected" ($a.ragContext.Count -gt 0) "chunks=$($a.ragContext.Count)"

      # The provider body is withheld: these scenarios deliberately echo prompt-like text.
      $errJson = $toolRun | ConvertTo-Json -Depth 6
      Check "$($case.scenario): no provider body in ToolRun.error" (
        -not ($errJson -match 'internal system prompt text' -or $errJson -match 'Offending content'))
      Check "$($case.scenario): no api key fragment in ToolRun.error" (-not ($errJson -match 'sk-live'))

      $session = Invoke-RestMethod -Uri "$base/review-sessions/$prId" -Headers $owner.headers
      Check "$($case.scenario): workspace still usable" ($session.sessionId -eq $prId)
      Check "$($case.scenario): gate still computed" ($null -ne $session.gate.blockingReasons)
    }

    Section 'Retry policy'

    function CallsByKind($kind) {
      ((Invoke-RestMethod -Uri "$stub/__calls").calls | Where-Object { $_.kind -eq $kind }).Count
    }

    # A schema violation is deterministic: one attempt, one repair, then stop. Retrying a model
    # that has already failed the same schema twice just spends money.
    SetScenario 'schema-invalid'
    Analyze $owner.headers $prId | Out-Null
    Check 'schema failure: one review attempt' ((CallsByKind 'review') -eq 1) "reviews=$(CallsByKind 'review')"
    Check 'schema failure: exactly one repair, then stops' ((CallsByKind 'repair') -eq 1) "repairs=$(CallsByKind 'repair')"

    # A rejected key would be rejected identically every time.
    SetScenario 'unauthorized'
    Analyze $owner.headers $prId | Out-Null
    Check 'rejected key: not retried' ((CallsByKind 'review') -eq 1) "reviews=$(CallsByKind 'review')"
    Check 'rejected key: no repair attempted' ((CallsByKind 'repair') -eq 0) "repairs=$(CallsByKind 'repair')"

    # A context-length rejection is also deterministic.
    SetScenario 'context-too-long'
    Analyze $owner.headers $prId | Out-Null
    Check 'context-length rejection: not retried' ((CallsByKind 'review') -eq 1) "reviews=$(CallsByKind 'review')"

    # A 5xx is transient, so the provider adapter does retry it.
    SetScenario 'provider-down'
    Analyze $owner.headers $prId | Out-Null
    Check 'transient 5xx: retried' ((CallsByKind 'review') -ge 2) "reviews=$(CallsByKind 'review')"

    SetScenario 'rate-limited'
    Analyze $owner.headers $prId | Out-Null
    Check 'transient 429: retried' ((CallsByKind 'review') -ge 2) "reviews=$(CallsByKind 'review')"

    SetScenario 'valid'
  }
}

Write-Host "`n================ $pass passed, $fail failed ================" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) { exit 1 }
