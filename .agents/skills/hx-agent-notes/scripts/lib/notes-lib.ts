/**
 * Barrel for the Agent Notes shared library. Every gate and authoring script imports from here,
 * so the module split inside this directory stays an implementation detail.
 */
export * from './config.ts'
export * from './tree.ts'
export * from './glob.ts'
export * from './manifest.ts'
export * from './seal.ts'
