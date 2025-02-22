const tempy = require('tempy');
const execa = require('execa');
const fileUrl = require('file-url');
const pReduce = require('p-reduce');
const gitLogParser = require('git-log-parser');
const getStream = require('get-stream');

/**
 * Create a temporary git repository.
 * If `withRemote` is `true`, creates a bare repository, initialize it and create a shallow clone. Change the current working directory to the clone root.
 * If `withRemote` is `false`, creates a regular repository and initialize it. Change the current working directory to the repository root.
 *
 * @param {Boolean} withRemote `true` to create a shallow clone of a bare repository.
 * @param {String} [branch='master'] The branch to initialize.
 * @return {String} The path of the clone if `withRemote` is `true`, the path of the repository otherwise.
 */
async function gitRepo(withRemote, branch = 'master') {
  let cwd = tempy.directory();

  await execa('git', ['init', ...(withRemote ? ['--bare'] : [])], {cwd});

  const repositoryUrl = fileUrl(cwd);
  if (withRemote) {
    await initBareRepo(repositoryUrl, branch);
    cwd = await gitShallowClone(repositoryUrl, branch);
  } else {
    await gitCheckout(branch, true, {cwd});
  }

  await execa('git', ['config', 'commit.gpgsign', false], {cwd});

  return {cwd, repositoryUrl};
}

/**
 * Initialize an existing bare repository:
 * - Clone the repository
 * - Change the current working directory to the clone root
 * - Create a default branch
 * - Create an initial commits
 * - Push to origin
 *
 * @param {String} repositoryUrl The URL of the bare repository.
 * @param {String} [branch='master'] the branch to initialize.
 */
async function initBareRepo(repositoryUrl, branch = 'master') {
  const cwd = tempy.directory();
  await execa('git', ['clone', '--no-hardlinks', repositoryUrl, cwd], {cwd});
  await gitCheckout(branch, true, {cwd});
  await gitCommits(['Initial commit'], {cwd});
  await execa('git', ['push', repositoryUrl, branch], {cwd});
}

/**
 * Create commits on the current git repository.
 *
 * @param {Array<string>} messages Commit messages.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 *
 * @returns {Array<Commit>} The created commits, in reverse order (to match `git log` order).
 */
async function gitCommits(messages, execaOptions) {
  await pReduce(
    messages,
    async (_, message) =>
      (
        await execa('git', ['commit', '-m', message, '--allow-empty', '--no-gpg-sign'], execaOptions)
      ).stdout
  );
  return (await gitGetCommits(undefined, execaOptions)).slice(0, messages.length);
}

/**
 * Get the list of parsed commits since a git reference.
 *
 * @param {String} [from] Git reference from which to seach commits.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 *
 * @return {Array<Object>} The list of parsed commits.
 */
async function gitGetCommits(from, execaOptions) {
  Object.assign(gitLogParser.fields, {hash: 'H', message: 'B', gitTags: 'd', committerDate: {key: 'ci', type: Date}});
  return (
    await getStream.array(
      gitLogParser.parse(
        {_: `${from ? from + '..' : ''}HEAD`},
        {...execaOptions, env: {...process.env, ...execaOptions.env}}
      )
    )
  ).map((commit) => {
    commit.message = commit.message.trim();
    commit.gitTags = commit.gitTags.trim();
    return commit;
  });
}

/**
 * Checkout a branch on the current git repository.
 *
 * @param {String} branch Branch name.
 * @param {Boolean} create to create the branch, `false` to checkout an existing branch.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 */
async function gitCheckout(branch, create, execaOptions) {
  await execa('git', create ? ['checkout', '-b', branch] : ['checkout', branch], execaOptions);
}

/**
 * Create a tag on the head commit in the current git repository.
 *
 * @param {String} tagName The tag name to create.
 * @param {String} [sha] The commit on which to create the tag. If undefined the tag is created on the last commit.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 */
async function gitTagVersion(tagName, sha, execaOptions) {
  await execa('git', sha ? ['tag', '-f', tagName, sha] : ['tag', tagName], execaOptions);
}

/**
 * Create a shallow clone of a git repository and change the current working directory to the cloned repository root.
 * The shallow will contain a limited number of commit and no tags.
 *
 * @param {String} repositoryUrl The path of the repository to clone.
 * @param {String} [branch='master'] the branch to clone.
 * @param {Number} [depth=1] The number of commit to clone.
 * @return {String} The path of the cloned repository.
 */
async function gitShallowClone(repositoryUrl, branch = 'master', depth = 1) {
  const cwd = tempy.directory();

  await execa('git', ['clone', '--no-hardlinks', '--no-tags', '-b', branch, '--depth', depth, repositoryUrl, cwd], {
    cwd,
  });
  return cwd;
}

/**
 * Create a git repo with a detached head from another git repository and change the current working directory to the new repository root.
 *
 * @param {String} repositoryUrl The path of the repository to clone.
 * @param {Number} head A commit sha of the remote repo that will become the detached head of the new one.
 * @return {String} The path of the new repository.
 */
async function gitDetachedHead(repositoryUrl, head) {
  const cwd = tempy.directory();

  await execa('git', ['init'], {cwd});
  await execa('git', ['remote', 'add', 'origin', repositoryUrl], {cwd});
  await execa('git', ['fetch', repositoryUrl], {cwd});
  await execa('git', ['checkout', head], {cwd});
  return cwd;
}

/**
 * Get the first commit sha referenced by the tag `tagName` in the remote repository.
 *
 * @param {String} repositoryUrl The repository remote URL.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 *
 * @return {String} The HEAD sha of the remote repository.
 */
async function gitRemoteHead(repositoryUrl, execaOptions) {
  return (await execa('git', ['ls-remote', repositoryUrl, 'HEAD'], execaOptions)).stdout
    .split('\n')
    .filter((head) => Boolean(head))
    .map((head) => head.match(/^(?<head>\S+)/)[1])[0];
}

/**
 * Get the first commit sha referenced by the tag `tagName` in the local repository.
 *
 * @param {String} repositoryUrl The repository remote URL.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 *
 * @return {String} The HEAD sha of the local repository.
 */
async function gitShowHead(execaOptions) {
  return (await execa('git', ['show', 'HEAD', '--quiet'], execaOptions)).stdout
    .split('\n')
    .filter((show) => show.startsWith('commit'))
    .map((commit) => commit.match(/^commit (?<commit>\S+)/)[1])[0];
}

/**
 *Get the list of staged files.
 *
 * @param {Object} [execaOpts] Options to pass to `execa`.
 *
 * @return {Array<String>} Array of staged files path.
 */
async function gitStaged(execaOptions) {
  return (await execa('git', ['status', '--porcelain'], execaOptions)).stdout
    .split('\n')
    .filter((status) => status.startsWith('A '))
    .map((status) => status.match(/^A\s+(?<file>.+)$/)[1]);
}

/**
 * Get the list of files included in a commit.
 *
 * @param {String} ref The git reference for which to retrieve the files.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 *
 * @return {Array<String>} The list of files path included in the commit.
 */
async function gitCommitedFiles(ref, execaOptions) {
  return (await execa('git', ['diff-tree', '-r', '--name-only', '--no-commit-id', '-r', ref], execaOptions)).stdout
    .split('\n')
    .filter((file) => Boolean(file));
}

/**
 * Add a list of file to the Git index.
 *
 * @param {Array<String>} files Array of files path to add to the index.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 */
async function gitAdd(files, execaOptions) {
  await execa('git', ['add', '--force', '--ignore-errors', ...files], {...execaOptions});
}

/**
 * Push to the remote repository.
 *
 * @param {String} repositoryUrl The remote repository URL.
 * @param {String} branch The branch to push.
 * @param {Object} [execaOpts] Options to pass to `execa`.
 */
async function gitPush(repositoryUrl, branch, execaOptions) {
  await execa('git', ['push', '--tags', repositoryUrl, `HEAD:${branch}`], execaOptions);
}

module.exports = {
  gitRepo,
  initBareRepo,
  gitCommits,
  gitGetCommits,
  gitCheckout,
  gitTagVersion,
  gitShallowClone,
  gitDetachedHead,
  gitRemoteHead,
  gitShowHead,
  gitStaged,
  gitCommitedFiles,
  gitAdd,
  gitPush,
};
