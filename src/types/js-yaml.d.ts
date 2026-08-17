declare module 'js-yaml' {
  export function load(text: string): unknown
  export function dump(obj: unknown, opts?: { indent?: number; noRefs?: boolean }): string
  const yaml: { load: typeof load; dump: typeof dump }
  export default yaml
}
