import type { NextConfig } from 'next';

const config: NextConfig = { transpilePackages: ['@axiom/pos'], agentRules: false };
export default config;
