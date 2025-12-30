declare module "sade" {
  export type Handler = (...args: any[]) => void | Promise<void>;

  export interface Command {
    command(name: string, description?: string): Command;
    option(flags: string, description?: string, defaultValue?: string | number | boolean): Command;
    action(handler: Handler): Command;
    parse(argv?: string[]): void;
  }

  export default function sade(name: string, isDefault?: boolean): Command;
}
