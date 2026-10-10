# Verifies the API contract the web MVP depends on, using the browser's own auth mechanism.
#
# The risky assumption in the frontend is that the access token can live in memory only: on reload
# the app exchanges the httpOnly refresh cookie for a new token. That works if, and only if, the
# cookie travels from :3000 to :4000. This exercises exactly that with a cookie jar, plus every
# endpoint each screen calls.
#
# Usage:  pwsh -File apps/web/test/verify-web-flow.ps1

$ErrorActionPreference = 'Stop'
$api = 'http://localhost:4000/api/v1'
$web = 'http://localhost:3000'
$pass = 0
$fail = 0

function Check($label, $condition, $detail = '') {
  if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
  else { Write-Host "  FAIL  $label $detail" -ForegroundColor Red; $script:fail++ }
}
function Section($name) { Write-Host "`n=== $name ===" -ForegroundColor Cyan }

# ---------------------------------------------------------------- auth
Section 'Auth: sign in and cookie-based silent refresh'

$session = $null
$signin = Invoke-RestMethod -Uri "$api/auth/signin" -Method Post -ContentType 'application/json' `
  -Body (@{ email = 'owner@acme.dev'; password = 'CodeLensDemo2026' } | ConvertTo-Json) `
  -SessionVariable session

Check 'signin returns an access token' ($signin.tokens.accessToken.Length -gt 40)
Check 'signin returns the user' ($signin.user.email -eq 'owner@acme.dev')
Check 'signin returns memberships' ($signin.organizations.Count -ge 1) "count=$($signin.organizations.Count)"
Check 'signin names an active organization' ($null -ne $signin.activeOrganizationId)
Check 'refresh token is NOT in the body' ($null -eq $signin.tokens.refreshToken)

$cookies = $session.Cookies.GetCookies('http://localhost:4000')
$refreshCookie = $cookies | Where-Object { $_.Name -like '*refresh*' } | Select-Object -First 1
Check 'refresh cookie was set' ($null -ne $refreshCookie) "cookies=$($cookies.Name -join ',')"
Check 'refresh cookie is httpOnly' ($refreshCookie.HttpOnly -eq $true)

# The whole in-memory-token design rests on this call succeeding with the cookie alone.
$refreshed = Invoke-RestMethod -Uri "$api/auth/refresh" -Method Post -ContentType 'application/json' `
  -Body '{}' -WebSession $session
Check 'refresh returns an access token using only the cookie' ($refreshed.tokens.accessToken.Length -gt 40)

# Deliberately not asserting that the token *string* changed. The API mints a fresh pair on every
# refresh, but a JWT signed in the same second with identical claims is byte-identical, so a
# string comparison would fail for a reason unrelated to correctness. Revocation in this design is
# by the tokenGeneration counter, not by rotating an opaque value.
#
# What matters to the frontend is that the cookie survives a refresh and stays usable, because the
# app refreshes on every reload and, before the single-flight guard in api-client, on every
# concurrent 401.
$afterRefresh = $session.Cookies.GetCookies('http://localhost:4000') |
  Where-Object { $_.Name -like '*refresh*' } | Select-Object -First 1
Check 'refresh re-sets the refresh cookie' ($null -ne $afterRefresh -and $afterRefresh.Value.Length -gt 40)

$secondRefresh = Invoke-RestMethod -Uri "$api/auth/refresh" -Method Post -ContentType 'application/json' `
  -Body '{}' -WebSession $session
Check 'a second refresh from the same jar still works' ($secondRefresh.tokens.accessToken.Length -gt 40)

$h = @{ Authorization = "Bearer $($secondRefresh.tokens.accessToken)" }

$sessionView = Invoke-RestMethod -Uri "$api/auth/session" -Headers $h
Check 'GET /auth/session works with the refreshed token' ($sessionView.user.email -eq 'owner@acme.dev')

# ---------------------------------------------------------------- dashboard
Section 'Dashboard data'

$org = Invoke-RestMethod -Uri "$api/organizations/current" -Headers $h
Check 'organization name present' ($org.name.Length -gt 0) "name=$($org.name)"
Check 'organization exposes repositoryCount' ($null -ne $org.repositoryCount)
Check 'organization exposes myRole' ($null -ne $org.myRole) "role=$($org.myRole)"

$health = Invoke-RestMethod -Uri "$api/health"
Check 'health reachable without auth' ($null -ne $health.status) "status=$($health.status)"
Check 'health exposes per-dependency checks' ($health.checks.Count -ge 4)
Check 'health marks required vs optional' (
  ($health.checks | Where-Object { $_.required }).Count -ge 2 -and
  ($health.checks | Where-Object { -not $_.required }).Count -ge 2)

$repos = Invoke-RestMethod -Uri "$api/repositories?page=1&pageSize=100" -Headers $h
Check 'repositories paginated envelope' ($null -ne $repos.total -and $null -ne $repos.items)
Check 'repository has the fields the table renders' (
  $null -ne $repos.items[0].fullName -and
  $null -ne $repos.items[0].defaultBranch -and
  $null -ne $repos.items[0].indexStatus -and
  $repos.items[0].PSObject.Properties.Name -contains 'private' -and
  $repos.items[0].PSObject.Properties.Name -contains 'lastSyncedAt')

$prs = Invoke-RestMethod -Uri "$api/pull-requests?page=1&pageSize=100" -Headers $h
Check 'pull requests paginated envelope' ($null -ne $prs.total)
$pr = $prs.items | Where-Object { $_.number -eq 412 } | Select-Object -First 1
Check 'seeded PR #412 present' ($null -ne $pr)
Check 'PR list item has risk + latestRun for the table' (
  $pr.PSObject.Properties.Name -contains 'risk' -and
  $pr.PSObject.Properties.Name -contains 'latestRun' -and
  $pr.PSObject.Properties.Name -contains 'humanReviewSummary')

$prId = $pr.id

# ---------------------------------------------------------------- workspace
Section 'Review workspace payload'

$ws = Invoke-RestMethod -Uri "$api/review-sessions/$prId" -Headers $h

foreach ($field in @('sessionId','repository','pullRequest','run','risk','findings','aiReview','aiReviewStatus','ragContext','toolRuns','reviews','gate','comments','shareLinks','permissions','degradation','metrics')) {
  Check "workspace field: $field" ($ws.PSObject.Properties.Name -contains $field)
}

Check 'aiReviewStatus has state + retryable' (
  $null -ne $ws.aiReviewStatus.state -and $ws.aiReviewStatus.PSObject.Properties.Name -contains 'retryable') `
  "state=$($ws.aiReviewStatus.state)"
Write-Host "  ai review state: $($ws.aiReviewStatus.state) retryable=$($ws.aiReviewStatus.retryable)"
Write-Host "  ai reason: $($ws.aiReviewStatus.reason)"

Check 'risk attributions present for the panel' ($ws.risk.reasons.Count -gt 0) "count=$($ws.risk.reasons.Count)"
Check 'findings present' ($ws.findings.Count -gt 0) "count=$($ws.findings.Count)"
Check 'findings carry fingerprint for finding-linked comments' ($null -ne $ws.findings[0].fingerprint)
Check 'rag summary has chunkCount' ($null -ne $ws.ragContext.chunkCount) "chunks=$($ws.ragContext.chunkCount)"
Check 'tool runs present with no output payload' (
  $ws.toolRuns.Count -ge 1 -and ($ws.toolRuns | Where-Object { $null -ne $_.output }).Count -eq 0)
Check 'permissions drive the buttons' (
  $ws.permissions.PSObject.Properties.Name -contains 'canApprove' -and
  $ws.permissions.PSObject.Properties.Name -contains 'canComment' -and
  $ws.permissions.PSObject.Properties.Name -contains 'canCreateShareLink')
Check 'gate present' ($null -ne $ws.gate.blockingReasons)

# ---------------------------------------------------------------- comment + verdict
Section 'Comment and verdict, as the UI submits them'

$reviewerSignin = Invoke-RestMethod -Uri "$api/auth/signin" -Method Post -ContentType 'application/json' `
  -Body (@{ email = 'reviewer@acme.dev'; password = 'CodeLensDemo2026' } | ConvertTo-Json)
$rh = @{ Authorization = "Bearer $($reviewerSignin.tokens.accessToken)" }

$comment = Invoke-RestMethod -Uri "$api/review-sessions/$prId/comments" -Method Post -Headers $rh `
  -ContentType 'application/json' -Body (@{ body = 'Checked from the web MVP flow.' } | ConvertTo-Json)
Check 'general comment created' ($null -ne $comment.id)

$critical = $ws.findings | Where-Object { $_.severity -eq 'CRITICAL' } | Select-Object -First 1
if ($critical) {
  $linked = Invoke-RestMethod -Uri "$api/review-sessions/$prId/comments" -Method Post -Headers $rh `
    -ContentType 'application/json' -Body (@{
      body = 'Finding-linked comment from the web flow.'
      path = $critical.path; line = $critical.line; findingFingerprint = $critical.fingerprint
    } | ConvertTo-Json)
  Check 'finding-linked comment created' ($linked.findingFingerprint -eq $critical.fingerprint)

  $resolved = Invoke-RestMethod -Uri "$api/comments/$($linked.id)/resolve" -Method Post -Headers $rh
  Check 'thread resolved' ($null -ne $resolved.resolvedAt)
  $reopened = Invoke-RestMethod -Uri "$api/comments/$($linked.id)/reopen" -Method Post -Headers $rh
  Check 'thread reopened' ($null -eq $reopened.resolvedAt)
}

$verdict = Invoke-RestMethod -Uri "$api/review-sessions/$prId/request-changes" -Method Post -Headers $rh `
  -ContentType 'application/json' -Body (@{ summary = 'Submitted from the web MVP flow.' } | ConvertTo-Json)
Check 'request-changes returns review + gate' ($verdict.review.verdict -eq 'CHANGES_REQUESTED' -and $null -ne $verdict.gate)

$approved = Invoke-RestMethod -Uri "$api/review-sessions/$prId/approve" -Method Post -Headers $rh `
  -ContentType 'application/json' -Body (@{ summary = 'Approved from the web MVP flow.' } | ConvertTo-Json)
Check 'approve returns review + gate' ($approved.review.verdict -eq 'APPROVED')

# ---------------------------------------------------------------- share link
Section 'Share link, created and read as the UI does'

$link = Invoke-RestMethod -Uri "$api/review-sessions/$prId/share-link" -Method Post -Headers $h `
  -ContentType 'application/json' -Body (@{ scope = 'FULL'; expiresInHours = 2; redactCode = $false } | ConvertTo-Json)
Check 'share link created with a one-time token' ($link.token.Length -ge 40)
Check 'share url embeds the token' ($link.url -like "*$($link.token)")

$shared = Invoke-RestMethod -Uri "$api/review-sessions/share/$($link.token)"
Check 'shared payload readable with no auth header' ($shared.shared -eq $true)
Check 'shared payload has findingSummary for the badge row' ($null -ne $shared.findingSummary.total)
Check 'shared payload has verdict counts' ($null -ne $shared.verdicts.approvals)

# Everything the shared page must never be able to render, because the API withholds it.
foreach ($forbidden in @('toolRuns','shareLinks','permissions','comments')) {
  Check "shared payload omits $forbidden" ($null -eq $shared.$forbidden)
}
$sharedJson = $shared | ConvertTo-Json -Depth 14
Check 'shared payload has no system prompt' (-not ($sharedJson -match 'You are one part of a larger review system'))
Check 'shared payload has no api key fragment' (-not ($sharedJson -match 'sk-'))
Check 'shared payload has no tool run id' (-not ($sharedJson -match $ws.toolRuns[0].id))

$webShareUrl = "$web/shared/$($link.token)"
Check 'share url points at the web app route shape' ($link.url -eq $webShareUrl)
Write-Host "  web share route to open: $webShareUrl"

# ---------------------------------------------------------------- web routes
Section 'Web app routes serve'

foreach ($route in @('/', '/signin', '/dashboard', '/repositories', '/pull-requests', '/activity', "/reviews/$prId", "/shared/$($link.token)")) {
  try {
    $response = Invoke-WebRequest -Uri "$web$route" -UseBasicParsing -TimeoutSec 30
    Check "GET $route -> $($response.StatusCode)" ($response.StatusCode -eq 200)
  } catch {
    Check "GET $route" $false "error=$($_.Exception.Message)"
  }
}

$shell = (Invoke-WebRequest -Uri "$web/signin" -UseBasicParsing).Content
Check 'signin page renders its heading server-side' ($shell -match 'CodeLens Enterprise')
Check 'signin page shows the configured API url' ($shell -match 'localhost:4000')

# ---------------------------------------------------------------- AI state, both ways
Section 'AI review state the workspace has to render'

$aiConfigured = (($health.checks | Where-Object { $_.name -eq 'ai-provider' }).ok)
Write-Host "  ai-provider configured: $aiConfigured"

# A fresh run so the stored state reflects the current configuration rather than an earlier one.
Invoke-RestMethod -Uri "$api/pull-requests/$prId/analyze" -Method Post -Headers $h `
  -ContentType 'application/json' -Body (@{ force = $true; sync = $true } | ConvertTo-Json) | Out-Null

$after = Invoke-RestMethod -Uri "$api/review-sessions/$prId" -Headers $h
Write-Host "  state=$($after.aiReviewStatus.state) retryable=$($after.aiReviewStatus.retryable)"
Write-Host "  reason=$($after.aiReviewStatus.reason)"

if ($aiConfigured) {
  Check 'AI enabled: review generated' ($after.aiReviewStatus.state -eq 'GENERATED')
  Check 'AI enabled: narrative available for the panel' ($after.aiReview.executiveSummary.Length -ge 20)
  Check 'AI enabled: recommendation present' ($null -ne $after.aiReview.effectiveRecommendation)
  Check 'AI enabled: checklist present' ($after.aiReview.reviewerChecklist.Count -gt 0)
  Check 'AI enabled: run reports the capability' ($after.run.capabilities.aiReview -eq $true)

  $link2 = Invoke-RestMethod -Uri "$api/review-sessions/$prId/share-link" -Method Post -Headers $h `
    -ContentType 'application/json' -Body (@{ scope = 'FULL'; expiresInHours = 2 } | ConvertTo-Json)
  $shared2 = Invoke-RestMethod -Uri "$api/review-sessions/share/$($link2.token)"
  Check 'AI enabled: shared view carries the narrative' ($shared2.aiReview.executiveSummary.Length -ge 20)
  Check 'AI enabled: shared view omits provider/model' (
    $null -eq $shared2.aiReview.provider -and $null -eq $shared2.aiReview.model)
  Check 'AI enabled: shared view omits token usage and cost' (
    $null -eq $shared2.aiReview.tokenUsage -and $null -eq $shared2.aiReview.costCents)
} else {
  Check 'AI disabled: state is SKIPPED' ($after.aiReviewStatus.state -eq 'SKIPPED')
  Check 'AI disabled: reason names the missing key' ($after.aiReviewStatus.reason -match 'No API key is configured')
  Check 'AI disabled: marked non-retryable so the UI hides a re-run button' ($after.aiReviewStatus.retryable -eq $false)
  Check 'AI disabled: aiReview is null' ($null -eq $after.aiReview)
  Check 'AI disabled: findings still render' ($after.findings.Count -gt 0)
  Check 'AI disabled: risk still renders' ($after.risk.score -gt 0)
  Check 'AI disabled: context still renders' ($after.ragContext.chunkCount -gt 0)
  Check 'AI disabled: gate still computed' ($null -ne $after.gate.blockingReasons)
}

Write-Host "`n================ $pass passed, $fail failed ================" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) { exit 1 }
