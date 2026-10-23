import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  GhPullRequest,
  findRemoteForPullRequest,
  indexPullRequests,
  normalizeRemoteUrl,
  parseCloneUrl,
  parsePullRequestUrl,
  pullRequestNumberForWorktree,
  pullRequestRepoUrl,
  remoteOwners,
  toPRInfo,
} from '../utils/github';

describe('indexPullRequests', () => {
  // As `gh pr list --state all --json ...` prints them: newest first, states upper-case.
  const pr = (number: number, headRefName: string, state: string, extra: Partial<GhPullRequest> = {}): GhPullRequest => ({
    number,
    title: `PR ${number}`,
    state,
    isDraft: false,
    url: `https://github.com/o/r/pull/${number}`,
    headRefName,
    isCrossRepository: false,
    ...extra,
  });

  it('shows merged and closed PRs, not only open ones', () => {
    const { byBranch } = indexPullRequests([pr(3, 'claude/eager-feynman', 'MERGED'), pr(2, 'feature/old', 'CLOSED')]);
    assert.equal(byBranch.get('claude/eager-feynman')?.state, 'merged');
    assert.equal(byBranch.get('feature/old')?.state, 'closed');
  });

  it("prefers a branch's open PR, then its newest one", () => {
    const { byBranch } = indexPullRequests([
      pr(9, 'feature/a', 'CLOSED'),
      pr(8, 'feature/a', 'OPEN'),
      pr(7, 'feature/b', 'MERGED'),
      pr(6, 'feature/b', 'CLOSED'),
    ]);
    assert.equal(byBranch.get('feature/a')?.number, 8);
    assert.equal(byBranch.get('feature/b')?.number, 7);
  });

  it("doesn't match someone else's fork branch to the local branch of the same name", () => {
    const { byBranch, byNumber } = indexPullRequests(
      [
        pr(5, 'main', 'OPEN', { isCrossRepository: true, headRepositoryOwner: { login: 'stranger' } }),
        pr(4, 'patch-1', 'OPEN', { isCrossRepository: true, headRepositoryOwner: { login: 'stranger' } }),
      ],
      ['you', 'upstream-org']
    );
    assert.equal(byBranch.size, 0);
    // Still findable by number, for worktrees made by Checkout PR.
    assert.equal(byNumber.get(5)?.headRefName, 'main');
  });

  it('matches PRs from your own fork (origin is a fork, gh reports PRs against upstream)', () => {
    const { byBranch } = indexPullRequests(
      [pr(6, 'claude/fix-login', 'MERGED', { isCrossRepository: true, headRepositoryOwner: { login: 'You' } })],
      ['you', 'upstream-org']
    );
    assert.equal(byBranch.get('claude/fix-login')?.number, 6);
  });

  it('reads the owners of the remotes', () => {
    assert.deepEqual(
      remoteOwners([
        { url: 'git@github.com:You/app.git' },
        { url: 'https://github.com/upstream-org/app.git' },
        { url: '/srv/git/local.git' },
      ]),
      ['you', 'upstream-org']
    );
  });

  it('normalizes states and fills in missing fields', () => {
    assert.deepEqual(toPRInfo({ number: 1, state: 'OPEN' }), { number: 1, title: '', state: 'open', isDraft: false, url: '', headRefName: '' });
    assert.equal(toPRInfo({ number: 1, state: 'SOMETHING_NEW' }).state, 'closed');
  });
});

describe('pullRequestNumberForWorktree', () => {
  it('recognizes worktrees made by Checkout PR, by recorded number or pr-<n> branch', () => {
    assert.equal(pullRequestNumberForWorktree('pr-4267', undefined), 4267);
    assert.equal(pullRequestNumberForWorktree('feature/login', 12), 12);
    assert.equal(pullRequestNumberForWorktree(null, 12), 12);
  });

  it('treats other worktrees as not from a PR', () => {
    for (const branch of ['main', 'claude/eager-feynman-8ff4f6', 'pr-', 'pr-12-fix', 'fix/pr-12', null]) {
      assert.equal(pullRequestNumberForWorktree(branch, undefined), undefined, String(branch));
    }
  });
});

describe('parsePullRequestUrl', () => {
  it('reads host, owner, repo and number', () => {
    assert.deepEqual(parsePullRequestUrl('https://github.com/MatthewChudleigh/agntree/pull/42'), {
      host: 'github.com',
      owner: 'MatthewChudleigh',
      repo: 'agntree',
      number: 42,
    });
    const enterprise = { host: 'ghe.example.com', owner: 'team', repo: 'app', number: 7 };
    assert.deepEqual(parsePullRequestUrl('https://ghe.example.com/team/app/pull/7/files'), enterprise);
    assert.deepEqual(parsePullRequestUrl('https://ghe.example.com/team/app/pull/7#discussion'), enterprise);
    assert.equal(parsePullRequestUrl('https://github.com/o/r/pull/7x'), null);
  });

  it('rejects anything that is not a PR URL or has unsafe names', () => {
    for (const url of ['', '42', 'https://github.com/o/r/issues/1', 'https://github.com/o/r', 'https://github.com/o/r%20x/pull/1', 'git@github.com:o/r.git']) {
      assert.equal(parsePullRequestUrl(url), null, url);
    }
  });
});

describe('normalizeRemoteUrl', () => {
  it('treats https, scp-style and ssh:// remotes for the same repo as equal', () => {
    const expected = 'github.com/matthewchudleigh/agntree';
    for (const url of [
      'https://github.com/MatthewChudleigh/agntree.git',
      'https://github.com/MatthewChudleigh/agntree',
      'https://github.com/MatthewChudleigh/agntree/',
      'https://user:token@github.com/MatthewChudleigh/agntree.git',
      'git@github.com:MatthewChudleigh/agntree.git',
      'ssh://git@github.com/MatthewChudleigh/agntree.git',
      'ssh://git@github.com:22/MatthewChudleigh/agntree',
    ]) {
      assert.equal(normalizeRemoteUrl(url), expected, url);
    }
  });

  it('returns null for local paths and malformed URLs', () => {
    for (const url of ['/srv/git/app.git', 'C:\\repos\\app', 'C:/repos/app', '../app', 'https://github.com/only-owner']) {
      assert.equal(normalizeRemoteUrl(url), null, url);
    }
  });
});

describe('findRemoteForPullRequest', () => {
  const pr = { host: 'github.com', owner: 'subhashkhileri', repo: 'agntree', number: 12 };

  it('finds the remote for the repository the PR was opened against', () => {
    const remotes = [
      { name: 'origin', url: 'git@github.com:MatthewChudleigh/agntree.git' },
      { name: 'upstream', url: 'https://github.com/subhashkhileri/agntree.git' },
    ];
    assert.equal(findRemoteForPullRequest(remotes, pr), 'upstream');
  });

  it('returns null when no remote matches, and builds a fetch URL instead', () => {
    assert.equal(findRemoteForPullRequest([{ name: 'origin', url: 'https://github.com/someone/else.git' }], pr), null);
    assert.equal(pullRequestRepoUrl(pr), 'https://github.com/subhashkhileri/agntree.git');
  });
});

describe('parseCloneUrl', () => {
  const ok = (input: string) => {
    const source = parseCloneUrl(input);
    assert.ok(source.ok, `${input}: ${!source.ok ? source.error : ''}`);
    return source.ok ? { url: source.url, name: source.name } : undefined;
  };

  it('keeps SSH addresses as typed', () => {
    assert.deepEqual(ok('git@github.com:owner/repo.git'), { url: 'git@github.com:owner/repo.git', name: 'repo' });
    assert.deepEqual(ok('git@github.com:owner/repo'), { url: 'git@github.com:owner/repo', name: 'repo' });
    assert.deepEqual(ok('ssh://git@github.com/owner/repo.git'), { url: 'ssh://git@github.com/owner/repo.git', name: 'repo' });
  });

  it('turns owner/repo into a GitHub URL', () => {
    assert.deepEqual(ok('owner/repo'), { url: 'https://github.com/owner/repo.git', name: 'repo' });
    assert.deepEqual(ok(' owner/my.repo.git '), { url: 'https://github.com/owner/my.repo.git', name: 'my.repo' });
  });

  it('clones the repository behind a GitHub page URL', () => {
    assert.deepEqual(ok('https://github.com/owner/repo'), { url: 'https://github.com/owner/repo.git', name: 'repo' });
    assert.deepEqual(ok('https://github.com/owner/repo/tree/main/src'), { url: 'https://github.com/owner/repo.git', name: 'repo' });
    assert.deepEqual(ok('github.com/owner/repo'), { url: 'https://github.com/owner/repo.git', name: 'repo' });
  });

  it('keeps other hosts as typed', () => {
    assert.deepEqual(ok('https://gitlab.example.com/group/sub/project.git'), {
      url: 'https://gitlab.example.com/group/sub/project.git',
      name: 'project',
    });
  });

  it('refuses input it cannot clone into a folder of its own', () => {
    for (const bad of ['', 'just words', '-oProxyCommand=evil', 'owner/..', 'https://github.com/owner/..', '../escape']) {
      assert.equal(parseCloneUrl(bad).ok, false, bad);
    }
  });
});
