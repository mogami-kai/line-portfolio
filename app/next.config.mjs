/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // ローカル import の `.js` 拡張子（TypeScript の bundler 解決流儀）を
    // `.ts` / `.tsx` に解決させる。例: `@/lib/db.js` → `src/lib/db.ts`。
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
