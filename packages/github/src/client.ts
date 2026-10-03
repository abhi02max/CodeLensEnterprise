import { Octokit } from '@octokit/rest';
import {
  MAX_COMMITS_FETCHED,
  MAX_FILES_PER_REVIEW,
  MAX_PATCH_CHARS_PER_FILE,
  classifyFile,
  detectLanguage,
  isAnalyzable,
  parseRepoFullName,
  retry,
  truncateLines,
  type CommitView,
  type GithubRepositoryOption,
  type ParsedFileDiff,
} from '@codelens/shared';
import { classifyGithubError, GithubError } from './errors';
import { parseFileDiff, touchedLineNumbers, type RawGithubFile } from './diff-parser';
import { verifyExactGitFile, type ExactGitFile } from './exact-git-file';

/**
 * GitHub REST client.
 *
 * Wraps Octokit to add three things the rest of the system depends on:
 *
 *   1. Every error is a {@link GithubError} with an actionable `kind`, so callers
 *      can distinguish "reconnect your account" from "wait and retry".
 *   2. Rate-limit-aware retry. GitHub's 5000/hr budget disappears quickly when
 *      indexing a repository, and a blind retry loop makes a secondary rate limit
 *      worse rather than better.
 *   3. Domain mapping. Callers receive our types, not GitHub's payloads, so a
 *      future GitLab adapter can satisfy the same interface.
 */

export interface GithubClientOptions {
  accessToken: string;
  /** Called after each request so the caller can surface remaining quota. */
  onRateLimit?: (info: RateLimitInfo) => void;
  /** Override for GitHub Enterprise Server. */
  baseUrl?: string;
  userAgent?: string;
  requestTimeoutMs?: number;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: Date;
  used: number;
}

export class GithubClient {
  private readonly octokit: Octokit;
  private lastRateLimit: RateLimitInfo | null = null;

  constructor(private readonly options: GithubClientOptions) {
    this.octokit = new Octokit({
      auth: options.accessToken,
      baseUrl: options.baseUrl ?? 'https://api.github.com',
      userAgent: options.userAgent ?? 'CodeLens-Enterprise/0.1',
      request: { timeout: options.requestTimeoutMs ?? 30_000 },
    });

    // Capture quota from every response rather than polling /rate_limit, which
    // would itself consume requests on some endpoints.
    this.octokit.hook.after('request', (response) => {
      const headers = response.headers as Record<string, string | undefined>;
      const limit = Number(headers['x-ratelimit-limit'] ?? 0);
      if (!limit) return;

      this.lastRateLimit = {
        limit,
        remaining: Number(headers['x-ratelimit-remaining'] ?? 0),
        resetAt: new Date(Number(headers['x-ratelimit-reset'] ?? 0) * 1000),
        used: Number(headers['x-ratelimit-used'] ?? 0),
      };
      this.options.onRateLimit?.(this.lastRateLimit);
    });
  }

  get rateLimit(): RateLimitInfo | null {
    return this.lastRateLimit;
  }

  /**
   * Single retry policy for every call.
   *
   * Rate limits wait for the reset the API reported rather than a guessed
   * backoff, capped so a job cannot block a worker for an hour.
   */
  private async request<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return retry(
      async () => {
        try {
          return await fn();
        } catch (error) {
          throw classifyGithubError(error);
        }
      },
      {
        attempts: 4,
        baseDelayMs: 800,
        maxDelayMs: 30_000,
        shouldRetry: (error) => error instanceof GithubError && error.retryable,
        onRetry: (error) => {
          if (error instanceof GithubError && error.retryAfterSeconds !== null) {
            const capped = Math.min(error.retryAfterSeconds, 30);
            return void new Promise((resolve) => setTimeout(resolve, capped * 1000));
          }
        },
      },
    ).catch((error: unknown) => {
      if (error instanceof GithubError) throw error;
      throw classifyGithubError(new Error(`${label} failed: ${String(error)}`));
    });
  }

  // -------------------------------------------------------------- identity

  async getAuthenticatedUser(): Promise<{
    githubId: number;
    login: string;
    name: string | null;
    email: string | null;
    avatarUrl: string;
  }> {
    const { data } = await this.request('getAuthenticatedUser', () =>
      this.octokit.users.getAuthenticated(),
    );

    let email: string | null = null;

    // Identity creation requires verified ownership, not merely a public profile field.
    try {
        const { data: emails } = await this.request('listEmails', () =>
          this.octokit.users.listEmailsForAuthenticatedUser(),
        );
        email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
    } catch {
      email = null;
    }

    return {
      githubId: data.id,
      login: data.login,
      name: data.name ?? null,
      email,
      avatarUrl: data.avatar_url,
    };
  }

  // -------------------------------------------------------------- repositories

  /**
   * Repositories the token can see, newest activity first.
   *
   * Uses the authenticated-user endpoint rather than a search query so private
   * and organization repositories are included.
   */
  async listAccessibleRepositories(
    options: { perPage?: number; maxPages?: number } = {},
  ): Promise<Omit<GithubRepositoryOption, 'connected'>[]> {
    const perPage = Math.min(options.perPage ?? 100, 100);
    const maxPages = options.maxPages ?? 5;
    const results: Omit<GithubRepositoryOption, 'connected'>[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const { data } = await this.request('listForAuthenticatedUser', () =>
        this.octokit.repos.listForAuthenticatedUser({
          per_page: perPage,
          page,
          sort: 'pushed',
          direction: 'desc',
          affiliation: 'owner,collaborator,organization_member',
        }),
      );

      for (const repo of data) {
        results.push({
          githubId: repo.id,
          fullName: repo.full_name,
          name: repo.name,
          owner: repo.owner.login,
          description: repo.description ?? null,
          private: repo.private,
          defaultBranch: repo.default_branch ?? 'main',
          language: repo.language ?? null,
          stargazersCount: repo.stargazers_count ?? 0,
          updatedAt: repo.pushed_at ?? repo.updated_at ?? new Date().toISOString(),
          permissions: {
            admin: repo.permissions?.admin ?? false,
            push: repo.permissions?.push ?? false,
            pull: repo.permissions?.pull ?? true,
          },
        });
      }

      if (data.length < perPage) break;
    }

    return results;
  }

  async getRepositoryMetadata(fullName: string): Promise<{
    githubId: number;
    fullName: string;
    name: string;
    owner: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    primaryLanguage: string | null;
    languages: Record<string, number>;
    topics: string[];
    sizeKb: number;
    htmlUrl: string;
    openIssuesCount: number;
    pushedAt: string | null;
  }> {
    const { owner, repo } = this.splitFullName(fullName);

    const [{ data }, languages] = await Promise.all([
      this.request('getRepo', () => this.octokit.repos.get({ owner, repo })),
      this.request('listLanguages', () => this.octokit.repos.listLanguages({ owner, repo }))
        .then((r) => r.data as Record<string, number>)
        .catch(() => ({}) as Record<string, number>),
    ]);

    return {
      githubId: data.id,
      fullName: data.full_name,
      name: data.name,
      owner: data.owner.login,
      description: data.description ?? null,
      private: data.private,
      defaultBranch: data.default_branch,
      primaryLanguage: data.language ?? null,
      languages,
      topics: data.topics ?? [],
      sizeKb: data.size,
      htmlUrl: data.html_url,
      openIssuesCount: data.open_issues_count,
      pushedAt: data.pushed_at ?? null,
    };
  }

  // -------------------------------------------------------------- pull requests

  async listPullRequests(
    fullName: string,
    options: { state?: 'open' | 'closed' | 'all'; limit?: number } = {},
  ): Promise<RawPullRequest[]> {
    const { owner, repo } = this.splitFullName(fullName);
    const limit = options.limit ?? 50;
    const results: RawPullRequest[] = [];

    for (let page = 1; results.length < limit; page += 1) {
      const perPage = Math.min(100, limit - results.length);

      const { data } = await this.request('listPulls', () =>
        this.octokit.pulls.list({
          owner,
          repo,
          state: options.state ?? 'open',
          per_page: perPage,
          page,
          sort: 'updated',
          direction: 'desc',
        }),
      );

      results.push(...data.map(mapPullRequestSummary));
      if (data.length < perPage) break;
    }

    return results.slice(0, limit);
  }

  async getPullRequest(fullName: string, number: number): Promise<RawPullRequest> {
    const { owner, repo } = this.splitFullName(fullName);
    const { data } = await this.request('getPull', () =>
      this.octokit.pulls.get({ owner, repo, pull_number: number }),
    );

    return {
      ...mapPullRequestSummary(data),
      additions: data.additions,
      deletions: data.deletions,
      changedFiles: data.changed_files,
      commitCount: data.commits,
      mergeable: data.mergeable ?? null,
    };
  }

  /**
   * Changed files with parsed diffs.
   *
   * Non-analyzable files (generated output, lockfiles) are still returned so the
   * UI can show them and the DEPENDENCY flag still fires, but their patch is
   * dropped. A 4000-line lockfile diff contributes nothing to a review and would
   * dominate the token budget.
   */
  async getPullRequestFiles(
    fullName: string,
    number: number,
    options: { maxFiles?: number } = {},
  ): Promise<PullRequestFileWithDiff[]> {
    const { owner, repo } = this.splitFullName(fullName);
    const maxFiles = Math.min(options.maxFiles ?? MAX_FILES_PER_REVIEW, MAX_FILES_PER_REVIEW);
    const raw: RawGithubFile[] = [];

    for (let page = 1; raw.length < maxFiles; page += 1) {
      const { data } = await this.request('listFiles', () =>
        this.octokit.pulls.listFiles({
          owner,
          repo,
          pull_number: number,
          per_page: 100,
          page,
        }),
      );

      raw.push(
        ...data.map((f) => ({
          filename: f.filename,
          previous_filename: f.previous_filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: f.patch,
        })),
      );

      if (data.length < 100) break;
    }

    return raw.slice(0, maxFiles).map((file) => {
      const analyzable = isAnalyzable(file.filename);

      let patch = file.patch ?? null;
      let patchTruncated = false;

      if (!analyzable) {
        patch = null;
      } else if (patch && patch.length > MAX_PATCH_CHARS_PER_FILE) {
        const result = truncateLines(patch, MAX_PATCH_CHARS_PER_FILE);
        patch = result.text;
        patchTruncated = result.truncated;
      }

      const parsed = parseFileDiff({ ...file, patch: patch ?? undefined });

      return {
        filename: file.filename,
        previousFilename: file.previous_filename ?? null,
        status: parsed.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        language: detectLanguage(file.filename),
        flags: classifyFile(file.filename),
        patch,
        patchTruncated,
        binary: parsed.binary,
        analyzable,
        touchedLines: touchedLineNumbers(parsed.hunks),
        diff: parsed,
      };
    });
  }

  async getPullRequestCommits(fullName: string, number: number): Promise<CommitView[]> {
    const { owner, repo } = this.splitFullName(fullName);
    const commits: CommitView[] = [];

    for (let page = 1; commits.length < MAX_COMMITS_FETCHED; page += 1) {
      const { data } = await this.request('listCommits', () =>
        this.octokit.pulls.listCommits({
          owner,
          repo,
          pull_number: number,
          per_page: 100,
          page,
        }),
      );

      for (const commit of data) {
        commits.push({
          sha: commit.sha,
          shortSha: commit.sha.slice(0, 7),
          message: commit.commit.message,
          authorName: commit.commit.author?.name ?? 'unknown',
          authorLogin: commit.author?.login ?? null,
          authoredAt: commit.commit.author?.date ?? new Date().toISOString(),
          additions: commit.stats?.additions ?? null,
          deletions: commit.stats?.deletions ?? null,
        });
      }

      if (data.length < 100) break;
    }

    return commits;
  }

  // -------------------------------------------------------------- file content

  async verifyExactFile(fullName: string, path: string, revision: string, options: { readContent?: boolean; signal?: AbortSignal } = {}): Promise<ExactGitFile> {
    const { owner, repo } = this.splitFullName(fullName);
    try {
      return await verifyExactGitFile({
        commit: async (commit_sha, signal) => (await this.octokit.git.getCommit({ owner, repo, commit_sha, request: { signal, timeout: 15000 } })).data,
        tree: async (tree_sha, signal) => (await this.octokit.git.getTree({ owner, repo, tree_sha, request: { signal, timeout: 15000 } })).data,
        blob: async (file_sha, signal) => (await this.octokit.git.getBlob({ owner, repo, file_sha, request: { signal, timeout: 15000 } })).data,
      }, revision, path, options);
    } catch (error) { throw classifyGithubError(error); }
  }

  /** Bounded UTF-8 text at a full commit SHA, with upstream Git blob identity. */
  async getFileSnapshot(fullName: string, path: string, revision: string, signal?: AbortSignal): Promise<{
    content: string; blobSha: string;
  } | null> {
    if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error('Exact commit SHA required');
    const { owner, repo } = this.splitFullName(fullName);
    const { data } = await this.request('getExactContent', () => {
      if (signal?.aborted) throw new GithubError('VALIDATION_FAILED', 'Read cancelled', 400);
      return this.octokit.repos.getContent({ owner, repo, path, ref: revision,
        request: { signal, timeout: 15_000 } });
    });
    if (Array.isArray(data) || data.type !== 'file') return null;
    if (data.size > 1024 * 1024 || !('content' in data) || data.encoding !== 'base64')
      throw new Error('File exceeds supported text bounds');
    const bytes = Buffer.from(data.content, 'base64');
    const content = bytes.toString('utf8');
    if (bytes.length > 1024 * 1024 || content.includes('\0') ||
        !Buffer.from(content, 'utf8').equals(bytes)) throw new Error('Unsupported binary file');
    return { content, blobSha: data.sha };
  }

  /** Decoded file content at a ref. Returns null for missing files or directories. */
  async getFileContent(fullName: string, path: string, ref?: string): Promise<string | null> {
    const { owner, repo } = this.splitFullName(fullName);

    try {
      const { data } = await this.request('getContent', () =>
        this.octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}) }),
      );

      if (Array.isArray(data) || data.type !== 'file') return null;
      if (!('content' in data) || typeof data.content !== 'string') return null;

      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof GithubError && error.kind === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /**
   * Flat file listing for a ref, used to drive repository indexing.
   *
   * The recursive tree endpoint is one request for the whole repository, which is
   * dramatically cheaper than walking directories. `truncated` signals we hit
   * GitHub's response cap and the caller should narrow the scope.
   */
  async listTree(
    fullName: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ files: Array<{ path: string; sizeBytes: number; sha: string }>; truncated: boolean }> {
    const { owner, repo } = this.splitFullName(fullName);

    const { data } = await this.request('getTree', () => {
      if (signal?.aborted) throw new GithubError('VALIDATION_FAILED', 'Read cancelled', 400);
      return this.octokit.git.getTree({ owner, repo, tree_sha: ref, recursive: 'true',
        ...(signal ? { request: { signal, timeout: 15_000 } } : {}) });
    });

    const files = data.tree
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => ({
        path: entry.path as string,
        sizeBytes: entry.size ?? 0,
        sha: entry.sha ?? '',
      }));

    return { files, truncated: data.truncated ?? false };
  }

  async getDefaultBranchSha(fullName: string, branch: string): Promise<string> {
    const { owner, repo } = this.splitFullName(fullName);
    const { data } = await this.request('getBranch', () =>
      this.octokit.repos.getBranch({ owner, repo, branch }),
    );
    return data.commit.sha;
  }

  // -------------------------------------------------------------- comments

  /**
   * Post or update the CodeLens review comment.
   *
   * Updates in place when a marker comment already exists. Re-running a review
   * should refresh the existing comment rather than spamming the thread, which is
   * what makes automatic re-analysis on push tolerable.
   */
  async upsertIssueComment(
    fullName: string,
    issueNumber: number,
    body: string,
    marker: string,
  ): Promise<{ commentId: number; htmlUrl: string; updated: boolean }> {
    const { owner, repo } = this.splitFullName(fullName);
    const markedBody = `${body}\n\n<!-- ${marker} -->`;

    const { data: existing } = await this.request('listComments', () =>
      this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      }),
    );

    const previous = existing.find((comment) => comment.body?.includes(`<!-- ${marker} -->`));

    if (previous) {
      const { data } = await this.request('updateComment', () =>
        this.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: previous.id,
          body: markedBody,
        }),
      );
      return { commentId: data.id, htmlUrl: data.html_url, updated: true };
    }

    const { data } = await this.request('createComment', () =>
      this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: markedBody,
      }),
    );

    return { commentId: data.id, htmlUrl: data.html_url, updated: false };
  }

  private splitFullName(fullName: string): { owner: string; repo: string } {
    const parsed = parseRepoFullName(fullName);
    if (!parsed) {
      throw new GithubError(
        'VALIDATION_FAILED',
        `Invalid repository name "${fullName}"; expected "owner/repo"`,
        400,
      );
    }
    return parsed;
  }
}

// ---------------------------------------------------------------- types

export interface RawPullRequest {
  githubId: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  htmlUrl: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commitCount?: number;
  mergeable?: boolean | null;
}

export interface PullRequestFileWithDiff {
  filename: string;
  previousFilename: string | null;
  status: ParsedFileDiff['status'];
  additions: number;
  deletions: number;
  changes: number;
  language: string;
  flags: string[];
  patch: string | null;
  patchTruncated: boolean;
  binary: boolean;
  /** False for generated files and lockfiles; their patch is dropped. */
  analyzable: boolean;
  touchedLines: number[];
  diff: ParsedFileDiff;
}

interface OctokitPullLike {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  draft?: boolean | undefined;
  merged_at: string | null;
  closed_at: string | null;
  html_url: string;
  user: { login: string; avatar_url: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  labels: Array<{ name?: string }>;
  created_at: string;
  updated_at: string;
}

function mapPullRequestSummary(pull: OctokitPullLike): RawPullRequest {
  return {
    githubId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? null,
    state: pull.state === 'closed' ? 'closed' : 'open',
    draft: pull.draft ?? false,
    merged: pull.merged_at !== null,
    mergedAt: pull.merged_at,
    closedAt: pull.closed_at,
    htmlUrl: pull.html_url,
    authorLogin: pull.user?.login ?? 'ghost',
    authorAvatarUrl: pull.user?.avatar_url ?? null,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
    labels: pull.labels.map((label) => label.name ?? '').filter(Boolean),
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
  };
}
