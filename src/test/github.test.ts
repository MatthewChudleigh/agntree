import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { findRemoteForPullRequest, normalizeRemoteUrl, parsePullRequestUrl, pullRequestRepoUrl } from '../utils/github';

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
