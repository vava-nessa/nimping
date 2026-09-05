/**
 * @file src/lib/site.ts
 * @description Site-wide constants for free-coding-models website.
 */

export const site = {
  name: 'free-coding-models',
  tagline: '100+ Free AI Coding Models with Auto-Failover & Health Checks',
  description:
    'Aggregate 200+ free AI coding models across NVIDIA NIM, Groq, Cerebras, Google AI Studio, OpenRouter, Pollinations and 18 more providers, with automatic health checks, latency sorting, SWE score ranking, and seamless CLI, Desktop and OpenCode integration.',
  url: 'https://free-coding-models.dev',
  repo: 'https://github.com/vava-nessa/free-coding-models',
  npm: 'https://www.npmjs.com/package/free-coding-models',
  issues: 'https://github.com/vava-nessa/free-coding-models/issues',
  author: 'Vanessa Depraute',
  authorUrl: 'https://vanessadepraute.dev',
  authorProfileUrl: 'https://free-coding-models.dev/creator',
  github: 'https://github.com/vava-nessa',
  linkedin: 'https://www.linkedin.com/in/vanessa-depraute-310b801ba/',
  twitter: 'https://x.com/vavanessadev',
} as const

export const INSTALL_COMMAND = 'npm install -g free-coding-models'
