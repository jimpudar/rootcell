import type { CommandResult, InheritedCommandResult } from "../types.ts";
import type { CopyToGuestOptions, ExecOptions } from "../providers/types.ts";

export interface GuestTransport {
  readonly id: string;
  exec(name: string, command: readonly string[], options?: ExecOptions): Promise<InheritedCommandResult>;
  execCapture(name: string, command: readonly string[], options?: ExecOptions): Promise<CommandResult>;
  execInteractive(name: string, command: readonly string[], options?: ExecOptions): Promise<number>;
  copyToGuest(name: string, hostPath: string, guestPath: string, options?: CopyToGuestOptions): Promise<void>;
}
