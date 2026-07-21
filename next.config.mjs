import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const isGithubPages = process.env.GITHUB_PAGES === 'true';
const basePath = isGithubPages && repo ? `/${repo}` : '';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

function commitHash() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    // No git metadata available (e.g. a source tarball) — the version number
    // on its own is still useful for support requests.
    return null;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_BUILD_VERSION: version,
    NEXT_PUBLIC_BUILD_COMMIT: commitHash() || '',
  },
};

export default nextConfig;
