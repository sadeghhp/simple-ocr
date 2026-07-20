const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const isGithubPages = process.env.GITHUB_PAGES === 'true';
const basePath = isGithubPages && repo ? `/${repo}` : '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
};

export default nextConfig;
