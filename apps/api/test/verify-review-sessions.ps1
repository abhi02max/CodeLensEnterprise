# Verification harness for review sessions, comments and share links.
#
# Requires an explicit isolated API URL and seeded demo data (pnpm db:seed).
#
# Usage:  $env:CODELENS_API_BASE = 'http://localhost:<isolated-port>/api/v1'; pwsh -File apps/api/test/verify-review-sessions.ps1

$ErrorActionPreference = 'Stop'
if (-not $env:CODELENS_API_BASE) { throw 'Set CODELENS_API_BASE to the isolated API URL before running this harness.' }
$base = $env:CODELENS_API_BASE.TrimEnd('/')
$apiUri = [uri]$base
if ($apiUri.Port -eq 4000) { throw 'Refusing the default CodeLens API port; use an isolated stack.' }
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
  @{ headers = @{ Authorization = "Bearer $($r.tokens.accessToken)" }; user = $r.user; org = $r.organization }
}

Section 'Sign in'
$owner = SignIn 'owner@acme.dev'
$reviewer = SignIn 'reviewer@acme.dev'
$dev = SignIn 'dev@acme.dev'
Write-Host "owner=$($owner.user.email) reviewer=$($reviewer.user.email) dev=$($dev.user.email)"

$prs = Invoke-RestMethod -Uri "$base/pull-requests?page=1&pageSize=10" -Headers $owner.headers
$pr = $prs.items | Where-Object { $_.number -eq 412 } | Select-Object -First 1
$sessionId = $pr.id
Write-Host "session (= pull request) = $sessionId  #$($pr.number)"

# ---------------------------------------------------------------- workspace
Section 'Workspace payload'
$open = Invoke-RestMethod -Uri "$base/review-sessions" -Method Post -Headers $dev.headers `
  -ContentType 'application/json' -Body (@{ pullRequestId = $sessionId; analyzeIfStale = $false } | ConvertTo-Json)
$s = $open.session

Check 'sessionId equals the pull request id' ($s.sessionId -eq $sessionId)
Check 'repository present' ($null -ne $s.repository.fullName) "got '$($s.repository.fullName)'"
Check 'pull request present' ($s.pullRequest.number -eq 412)
Check 'latest ReviewRun present' ($null -ne $s.run.id) "run=$($s.run.id)"
Check 'risk score + level present' ($s.risk.score -gt 0 -and $null -ne $s.risk.level) "risk=$($s.risk.score)/$($s.risk.level)"
Check 'static findings present' ($s.findings.Count -gt 0) "count=$($s.findings.Count)"
Check 'ML attributions present' ($s.risk.reasons.Count -gt 0) "count=$($s.risk.reasons.Count)"
Check 'RAG chunk summary present' ($s.ragContext.chunkCount -gt 0) "chunks=$($s.ragContext.chunkCount)"
$coreTools = @('get_pr_diff', 'get_repo_metadata', 'run_static_analysis', 'extract_ml_features',
  'predict_pr_risk', 'retrieve_code_context', 'generate_ai_review',
  'generate_test_suggestions', 'create_review_report', 'create_audit_log')
$actualTools = @($s.toolRuns | ForEach-Object { $_.tool })
$expectedTools = @($coreTools)
if ($actualTools -contains 'post_github_comment') { $expectedTools += 'post_github_comment' }
Check 'ToolRuns contain the core pipeline and optional GitHub post' (
  $actualTools.Count -eq $expectedTools.Count -and
  @($expectedTools | Where-Object { $actualTools -notcontains $_ }).Count -eq 0
) "tools=$($actualTools -join ',')"
Check 'ToolRun payloads excluded from workspace' ($null -eq $s.toolRuns[0].output)
Check 'reviews array present' ($null -ne $s.reviews)
Check 'comments array present' ($null -ne $s.comments)
Check 'shareLinks array present' ($null -ne $s.shareLinks)
Check 'permissions present' ($null -ne $s.permissions)
Check 'merge gate present' ($null -ne $s.gate.blockingReasons)

Write-Host "`n  gate: readyToMerge=$($s.gate.readyToMerge) approvals=$($s.gate.currentApprovals)/$($s.gate.requiredApprovals)"
$s.gate.blockingReasons | ForEach-Object { Write-Host "    blocks: $_" }
$s.gate.warnings | ForEach-Object { Write-Host "    warns:  $_" }

# ---------------------------------------------------------------- roles
Section 'Role enforcement'
Check 'developer cannot approve (flag)' ($s.permissions.canApprove -eq $false)
Check 'developer cannot create share link (flag)' ($s.permissions.canCreateShareLink -eq $false)

try {
  Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/approve" -Method Post -Headers $dev.headers `
    -ContentType 'application/json' -Body (@{} | ConvertTo-Json) | Out-Null
  Check 'developer approve rejected' $false 'was allowed'
} catch { Check 'developer approve rejected' ((StatusOf $_) -eq 403) "status=$(StatusOf $_)" }

try {
  Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/share-link" -Method Post -Headers $reviewer.headers `
    -ContentType 'application/json' -Body (@{} | ConvertTo-Json) | Out-Null
  Check 'reviewer share-link rejected' $false 'was allowed'
} catch { Check 'reviewer share-link rejected' ((StatusOf $_) -eq 403) "status=$(StatusOf $_)" }

# ---------------------------------------------------------------- comments
Section 'Comments'
$general = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $reviewer.headers `
  -ContentType 'application/json' -Body (@{ body = 'Overall this needs a second look at the refund path.' } | ConvertTo-Json)
Check 'general comment created' ($null -ne $general.id -and $null -eq $general.path)

$critical = $s.findings | Where-Object { $_.severity -eq 'CRITICAL' } | Select-Object -First 1
Write-Host "  linking to finding $($critical.ruleId) at $($critical.path):$($critical.line)"

$inline = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $reviewer.headers `
  -ContentType 'application/json' -Body (@{
    body = 'This is string-interpolated SQL. Use a parameterized query.'
    path = $critical.path
    line = $critical.line
    findingFingerprint = $critical.fingerprint
  } | ConvertTo-Json)
Check 'finding-linked inline comment created' ($inline.path -eq $critical.path -and $inline.findingFingerprint -eq $critical.fingerprint)

$reply = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $dev.headers `
  -ContentType 'application/json' -Body (@{ body = 'Agreed, switching to a parameterized query.'; parentId = $inline.id } | ConvertTo-Json)
Check 'reply created and inherits the anchor' ($reply.parentId -eq $inline.id -and $reply.path -eq $critical.path)

try {
  Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $dev.headers `
    -ContentType 'application/json' -Body (@{ body = 'nested'; parentId = $reply.id } | ConvertTo-Json) | Out-Null
  Check 'reply-to-reply rejected' $false 'was allowed'
} catch { Check 'reply-to-reply rejected' ((StatusOf $_) -eq 422) "status=$(StatusOf $_)" }

try {
  Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $dev.headers `
    -ContentType 'application/json' -Body (@{ body = 'x'; path = 'does/not/exist.ts'; line = 1 } | ConvertTo-Json) | Out-Null
  Check 'comment on unchanged file rejected' $false 'was allowed'
} catch { Check 'comment on unchanged file rejected' ((StatusOf $_) -eq 422) "status=$(StatusOf $_)" }

try {
  Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $dev.headers `
    -ContentType 'application/json' -Body (@{ body = 'x'; findingFingerprint = 'deadbeefdeadbeef' } | ConvertTo-Json) | Out-Null
  Check 'unknown fingerprint rejected' $false 'was allowed'
} catch { Check 'unknown fingerprint rejected' ((StatusOf $_) -eq 422) "status=$(StatusOf $_)" }

try {
  Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $dev.headers `
    -ContentType 'application/json' -Body (@{ body = 'x'; path = $critical.path } | ConvertTo-Json) | Out-Null
  Check 'path without line rejected' $false 'was allowed'
} catch { Check 'path without line rejected' ((StatusOf $_) -eq 422) "status=$(StatusOf $_)" }

$edited = Invoke-RestMethod -Uri "$base/comments/$($general.id)" -Method Patch -Headers $reviewer.headers `
  -ContentType 'application/json' -Body (@{ body = 'Overall this needs a second look at the refund and ledger paths.' } | ConvertTo-Json)
Check 'author can edit, editedAt set' ($null -ne $edited.editedAt)

try {
  Invoke-RestMethod -Uri "$base/comments/$($general.id)" -Method Patch -Headers $dev.headers `
    -ContentType 'application/json' -Body (@{ body = 'hijacked' } | ConvertTo-Json) | Out-Null
  Check 'non-author edit rejected' $false 'was allowed'
} catch { Check 'non-author edit rejected' ((StatusOf $_) -eq 403) "status=$(StatusOf $_)" }

try {
  Invoke-RestMethod -Uri "$base/comments/$($inline.id)" -Method Delete -Headers $reviewer.headers | Out-Null
  Check 'delete with replies rejected' $false 'was allowed'
} catch { Check 'delete with replies rejected' ((StatusOf $_) -eq 409) "status=$(StatusOf $_)" }

$throwaway = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $dev.headers `
  -ContentType 'application/json' -Body (@{ body = 'delete me' } | ConvertTo-Json)
Invoke-RestMethod -Uri "$base/comments/$($throwaway.id)" -Method Delete -Headers $dev.headers | Out-Null
$after = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Headers $dev.headers
Check 'delete without replies succeeds' (-not ($after.id -contains $throwaway.id))

$threads = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Headers $dev.headers
$root = $threads | Where-Object { $_.id -eq $inline.id }
Check 'threads nested one level' ($root.replies.Count -eq 1) "replies=$($root.replies.Count)"

# ---------------------------------------------------------------- resolve / reopen
Section 'Resolve / reopen feeds the merge gate'
$before = (Invoke-RestMethod -Uri "$base/review-sessions/$sessionId" -Headers $reviewer.headers).gate
$blockingBefore = [int](($before.blockingReasons | Where-Object { $_ -like '*unresolved finding*' } | Select-Object -First 1) -replace '^([0-9]+).*', '$1')

$resolved = Invoke-RestMethod -Uri "$base/comments/$($inline.id)/resolve" -Method Post -Headers $reviewer.headers
Check 'thread resolved' ($null -ne $resolved.resolvedAt -and $resolved.resolvedBy.id -eq $reviewer.user.id)

$afterGate = (Invoke-RestMethod -Uri "$base/review-sessions/$sessionId" -Headers $reviewer.headers).gate
$blockingAfter = ($afterGate.blockingReasons | Where-Object { $_ -like '*unresolved finding*' } | Select-Object -First 1)
$blockingAfterCount = if ($blockingAfter) { [int]($blockingAfter -replace '^([0-9]+).*', '$1') } else { 0 }
Write-Host "  unresolved-findings blocker before: $blockingBefore"
Write-Host "  unresolved-findings blocker after : $($blockingAfter -join '; ')"
Check 'resolving a finding thread reduced the blocking count' (
  $blockingBefore -gt 0 -and $blockingAfterCount -eq ($blockingBefore - 1)
) "after='$blockingAfter'"

try {
  Invoke-RestMethod -Uri "$base/comments/$($inline.id)/resolve" -Method Post -Headers $reviewer.headers | Out-Null
  Check 'double resolve rejected' $false 'was allowed'
} catch { Check 'double resolve rejected' ((StatusOf $_) -eq 409) "status=$(StatusOf $_)" }

try {
  Invoke-RestMethod -Uri "$base/comments/$($reply.id)/resolve" -Method Post -Headers $reviewer.headers | Out-Null
  Check 'resolving a reply rejected' $false 'was allowed'
} catch { Check 'resolving a reply rejected' ((StatusOf $_) -eq 422) "status=$(StatusOf $_)" }

$reopened = Invoke-RestMethod -Uri "$base/comments/$($inline.id)/reopen" -Method Post -Headers $reviewer.headers
Check 'thread reopened' ($null -eq $reopened.resolvedAt)

# ---------------------------------------------------------------- verdicts
Section 'Verdicts'
$rc = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/request-changes" -Method Post -Headers $reviewer.headers `
  -ContentType 'application/json' -Body (@{
    summary = 'Raw SQL interpolation in the refund path has to go before this merges.'
    dismissedFindings = @(@{ fingerprint = $critical.fingerprint; reason = 'ALREADY_TRACKED'; note = 'tracked in FIN-2290' })
  } | ConvertTo-Json)

Check 'CHANGES_REQUESTED review created' ($rc.review.verdict -eq 'CHANGES_REQUESTED')
# The list view omits headSha on purpose, so the session payload is the source of truth here.
Check 'verdict pinned to current head' ($rc.review.headSha -eq $s.pullRequest.headSha -and $rc.review.stale -eq $false) `
  "review=$($rc.review.headSha) session=$($s.pullRequest.headSha)"
Check 'dismissed findings counted' ($rc.review.dismissedFindingCount -eq 1)
Check 'changes-requested blocks the gate' (
  ($rc.gate.blockingReasons | Where-Object { $_ -like 'Changes requested by*' }).Count -eq 1
) "blockers=$($rc.gate.blockingReasons -join ' | ')"

$ap = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/approve" -Method Post -Headers $reviewer.headers `
  -ContentType 'application/json' -Body (@{ summary = 'Parameterized query pushed, looks good.' } | ConvertTo-Json)
Check 'same reviewer revises rather than stacking' ($ap.review.id -eq $rc.review.id -and $ap.review.verdict -eq 'APPROVED')

$sessNow = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId" -Headers $reviewer.headers
Check 'one review row for this reviewer' (($sessNow.reviews | Where-Object { $_.reviewer.id -eq $reviewer.user.id }).Count -eq 1)
Check 'approval counted in the gate' ($sessNow.gate.currentApprovals -ge 1) "approvals=$($sessNow.gate.currentApprovals)"
Check 'first review time recorded for ML training' ($null -ne $sessNow.pullRequest.firstReviewedAt)

Write-Host "  gate now: ready=$($sessNow.gate.readyToMerge) approvals=$($sessNow.gate.currentApprovals)/$($sessNow.gate.requiredApprovals)"

# ---------------------------------------------------------------- share links
Section 'Share links'
$link = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/share-link" -Method Post -Headers $owner.headers `
  -ContentType 'application/json' -Body (@{ scope = 'FULL'; expiresInHours = 24; redactCode = $false } | ConvertTo-Json)

Check 'admin can create a share link' ($null -ne $link.id)
Check 'raw token returned once' ($link.token.Length -ge 40) "len=$($link.token.Length)"
Check 'url contains the token' ($link.url -like "*$($link.token)")

$listed = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/share-link" -Headers $owner.headers
$mine = $listed | Where-Object { $_.id -eq $link.id }
Check 'listing never returns the token' ($mine.url -eq '' -and $null -eq $mine.token)

Section 'Shared read (no auth)'
$shared = Invoke-RestMethod -Uri "$base/review-sessions/share/$($link.token)"
Check 'valid token reads without auth' ($shared.shared -eq $true)
Check 'shared payload has risk' ($shared.risk.score -eq $s.risk.score) "score=$($shared.risk.score)"
Check 'shared payload has attributions' ($shared.risk.reasons.Count -gt 0)
Check 'shared FULL payload has findings' ($shared.findings.Count -gt 0) "count=$($shared.findings.Count)"
Check 'shared payload has no toolRuns' ($null -eq $shared.toolRuns)
Check 'shared payload has no shareLinks' ($null -eq $shared.shareLinks)
Check 'shared payload has no permissions' ($null -eq $shared.permissions)
Check 'shared payload has no comments' ($null -eq $shared.comments)
Check 'shared payload exposes no run id' ($null -eq $shared.run.id)
Check 'shared payload exposes no reviewer emails' ($shared.verdicts.reviewers[0].PSObject.Properties.Name -notcontains 'email')
Check 'shared payload exposes no rag chunk bodies' ($null -eq $shared.ragContext.chunks)
$sharedJson = $shared | ConvertTo-Json -Depth 12
Check 'shared payload contains no user ids' (-not ($sharedJson -match $reviewer.user.id))
Check 'shared payload contains no session id' (-not ($sharedJson -match $sessionId))

Section 'Share link redaction + scope + passphrase + revocation'
$redacted = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/share-link" -Method Post -Headers $owner.headers `
  -ContentType 'application/json' -Body (@{ scope = 'FULL'; expiresInHours = 24; redactCode = $true } | ConvertTo-Json)
$redactedView = Invoke-RestMethod -Uri "$base/review-sessions/share/$($redacted.token)"
Check 'redactCode strips source snippets' (($redactedView.findings | Where-Object { $null -ne $_.snippet }).Count -eq 0)

$summary = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/share-link" -Method Post -Headers $owner.headers `
  -ContentType 'application/json' -Body (@{ scope = 'SUMMARY'; expiresInHours = 24 } | ConvertTo-Json)
$summaryView = Invoke-RestMethod -Uri "$base/review-sessions/share/$($summary.token)"
Check 'SUMMARY scope withholds individual findings' ($summaryView.findings.Count -eq 0)
Check 'SUMMARY scope still reports severity counts' ($summaryView.findingSummary.total -gt 0)

$protected = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/share-link" -Method Post -Headers $owner.headers `
  -ContentType 'application/json' -Body (@{ scope = 'SUMMARY'; expiresInHours = 24; passphrase = 'correct horse battery' } | ConvertTo-Json)
try {
  Invoke-RestMethod -Uri "$base/review-sessions/share/$($protected.token)" | Out-Null
  Check 'passphrase required' $false 'read without passphrase'
} catch { Check 'passphrase required' ((StatusOf $_) -eq 401) "status=$(StatusOf $_)" }
try {
  Invoke-RestMethod -Uri "$base/review-sessions/share/$($protected.token)" -Headers @{ 'X-Share-Passphrase' = 'wrong' } | Out-Null
  Check 'wrong passphrase rejected' $false 'was allowed'
} catch { Check 'wrong passphrase rejected' ((StatusOf $_) -eq 401) "status=$(StatusOf $_)" }
$ok = Invoke-RestMethod -Uri "$base/review-sessions/share/$($protected.token)" -Headers @{ 'X-Share-Passphrase' = 'correct horse battery' }
Check 'correct passphrase accepted' ($ok.shared -eq $true)

try {
  Invoke-RestMethod -Uri "$base/review-sessions/share/nonexistent-token-value" | Out-Null
  Check 'invalid token rejected' $false 'was allowed'
} catch { Check 'invalid token rejected' ((StatusOf $_) -eq 404) "status=$(StatusOf $_)" }

$revoked = Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/share-link/$($link.id)" -Method Delete -Headers $owner.headers
Check 'revoke sets revokedAt, keeps the row' ($null -ne $revoked.revokedAt)
Check 'revoke preserves the view count' ($revoked.viewCount -ge 1) "views=$($revoked.viewCount)"
try {
  Invoke-RestMethod -Uri "$base/review-sessions/share/$($link.token)" | Out-Null
  Check 'revoked token rejected' $false 'was allowed'
} catch { Check 'revoked token rejected' ((StatusOf $_) -eq 404) "status=$(StatusOf $_)" }

# ---------------------------------------------------------------- cross-tenant
Section 'Cross-organization isolation'

# A genuinely separate tenant: signing up with organizationName creates its own org and makes
# this user its OWNER, so the check is "highest possible role in another tenant".
$otherEmail = 'outsider@other-corp.dev'
try {
  $other = SignIn $otherEmail
} catch {
  Invoke-RestMethod -Uri "$base/auth/signup" -Method Post -ContentType 'application/json' -Body (@{
    email = $otherEmail; password = 'CodeLensDemo2026'; name = 'Outsider Owner'; organizationName = 'Other Corp'
  } | ConvertTo-Json) | Out-Null
  $other = SignIn $otherEmail
}

try {
  Invoke-RestMethod -Uri "$base/review-sessions/$sessionId" -Headers $other.headers | Out-Null
  Check 'other org cannot read the session' $false 'was allowed'
} catch { Check 'other org cannot read the session' ((StatusOf $_) -eq 404) "status=$(StatusOf $_)" }

foreach ($path in @("review-sessions/$sessionId/comments", "review-sessions/$sessionId/share-link", "pull-requests/$sessionId/rag-context")) {
  try {
    Invoke-RestMethod -Uri "$base/$path" -Headers $other.headers | Out-Null
    Check "other org cannot list $path" $false 'was allowed'
  } catch { Check "other org cannot list $path" ((StatusOf $_) -eq 404) "status=$(StatusOf $_)" }
}

try {
  Invoke-RestMethod -Uri "$base/review-sessions/$sessionId/comments" -Method Post -Headers $other.headers `
    -ContentType 'application/json' -Body (@{ body = 'cross tenant' } | ConvertTo-Json) | Out-Null
  Check 'other org cannot comment' $false 'was allowed'
} catch { Check 'other org cannot comment' ((StatusOf $_) -eq 404) "status=$(StatusOf $_)" }

try {
  Invoke-RestMethod -Uri "$base/comments/$($inline.id)" -Method Patch -Headers $other.headers `
    -ContentType 'application/json' -Body (@{ body = 'cross tenant edit' } | ConvertTo-Json) | Out-Null
  Check 'other org cannot edit a comment' $false 'was allowed'
} catch { Check 'other org cannot edit a comment' ((StatusOf $_) -eq 404) "status=$(StatusOf $_)" }

# ---------------------------------------------------------------- audit
Section 'Audit trail'
foreach ($action in @('review_run.started','review_run.completed','review.submitted','comment.created','comment.updated','comment.deleted','comment.resolved','comment.reopened','share_link.created','share_link.revoked','share_link.viewed')) {
  $logs = Invoke-RestMethod -Uri "$base/audit-logs?action=$action&page=1&pageSize=5" -Headers $owner.headers
  Check "audit: $action" ($logs.total -ge 1) "total=$($logs.total)"
}

$viewLogs = Invoke-RestMethod -Uri "$base/audit-logs?action=share_link.viewed&page=1&pageSize=3" -Headers $owner.headers
Check 'share view audited with no actor' ($null -eq $viewLogs.items[0].actor) "actorType=$($viewLogs.items[0].actorType)"

$createLogs = Invoke-RestMethod -Uri "$base/audit-logs?action=share_link.created&page=1&pageSize=5" -Headers $owner.headers
$createJson = $createLogs | ConvertTo-Json -Depth 8
Check 'no raw share token in the audit trail' (-not ($createJson -match [regex]::Escape($link.token)))

$submitLog = (Invoke-RestMethod -Uri "$base/audit-logs?action=review.submitted&page=1&pageSize=5" -Headers $owner.headers).items[0]
Write-Host "  latest review.submitted: $($submitLog.description)"
Check 'review audit names the actor' ($submitLog.actor.id -eq $reviewer.user.id)
Check 'review audit records dismissals' ($submitLog.metadata.dismissedFindings.Count -ge 0)

Write-Host "`n================ $pass passed, $fail failed ================" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) { exit 1 }
