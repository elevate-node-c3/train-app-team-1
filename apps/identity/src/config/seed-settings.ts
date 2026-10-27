/**
 * The staff seed is a CLI composition root. It still reads the process
 * environment through `config/`, so the module-first rule has one place to
 * audit for `process.env`.
 */
export function seedEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}
