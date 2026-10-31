declare module "proper-lockfile" {
  export interface LockOptions {
    readonly stale?: number;
    readonly update?: number | null;
    readonly realpath?: boolean;
    readonly retries?:
      | number
      | {
          readonly retries?: number;
          readonly factor?: number;
          readonly minTimeout?: number;
          readonly maxTimeout?: number;
          readonly randomize?: boolean;
        };
    readonly lockfilePath?: string;
    readonly onCompromised?: (err: Error) => void;
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
}
