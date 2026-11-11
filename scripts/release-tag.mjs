// A tag that does not start with vivijure-mcp-v never starts publish-npm.yml.
// An absent run looks like a passed one. This is the check that goes red instead.
import { fileURLToPath, pathToFileURL } from "node:url";

const PREFIX = "vivijure-mcp-v";

export function releaseTagFailure(tag) {
  const name = typeof tag === "string" ? tag : "";
  if (name.startsWith(PREFIX) && name.length > PREFIX.length) return null;
  return (
    `tag ${JSON.stringify(name)} does not match ${PREFIX}*. ` +
    `publish-npm.yml will not run, so this tag publishes nothing.`
  );
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  return fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(arg));
}

if (invokedDirectly()) {
  const tag = process.env.GITHUB_REF_NAME ?? "";
  const err = releaseTagFailure(tag);
  if (err) {
    console.error(`::error::${err}`);
    process.exit(1);
  }
  console.log(`${tag} matches ${PREFIX}*`);
}
