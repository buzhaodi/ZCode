/** sql.js 类型声明 — sql.js 不自带 .d.ts，这里提供最小接口定义 */
declare module "sql.js" {
  interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  interface SqlJsStatic {
    Database: new (data?: Uint8Array | ArrayBuffer | null) => Database;
  }

  interface BindParams {
    [key: string]: unknown;
  }

  export interface Statement {
    bind(params: unknown[] | BindParams | null): boolean;
    step(): boolean | null;
    getAsObject(params?: unknown[] | BindParams): Record<string, unknown>;
    get(params?: unknown[] | BindParams): unknown[];
    getColumnNames(): string[];
    reset(): void;
    free(): boolean;
    run(params?: unknown[] | BindParams): void;
  }

  export interface Database {
    run(sql: string, params?: unknown[] | BindParams): Database;
    exec(sql: string): Record<string, unknown>[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
