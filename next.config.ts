import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ホームディレクトリに置き去りの package-lock.json を Turbopack が
  // ルート候補として拾ってしまうため、明示的にこのリポジトリを指す。
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
