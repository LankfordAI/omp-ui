import type {
  BackendTransport,
  EventChannel,
  NotifyChannel,
  RequestChannel,
} from "./backend-channels";

type AnyChannel =
  | RequestChannel<unknown[], unknown>
  | NotifyChannel<unknown[]>
  | EventChannel<unknown[]>;

/** Any channel-spec object: method name → runtime descriptor carrying its wire channel. */
export type ChannelSpec = Record<string, { readonly channel: string } & AnyChannel>;

type ClientMethod<Descriptor> = Descriptor extends RequestChannel<infer Args, infer Result>
  ? (...args: Args) => Promise<Result>
  : Descriptor extends NotifyChannel<infer Args>
    ? (...args: Args) => void
    : Descriptor extends EventChannel<infer Args>
      ? (cb: (...args: Args) => void) => void
      : never;

/** The typed client a spec derives: one method per spec member. */
export type ChannelClient<Spec extends ChannelSpec> = {
  readonly [Method in keyof Spec & string]: ClientMethod<Spec[Method]>;
};

/**
 * Builds every method of `spec` over the transport primitives: request →
 * `transport.request(channel, args)`, notify → `transport.notify(channel, args)`,
 * event → `transport.on(channel, cb)`.
 */
export function makeChannelClient<Spec extends ChannelSpec>(
  spec: Spec,
  transport: BackendTransport,
): ChannelClient<Spec> {
  const client: Record<string, (...args: never[]) => unknown> = {};

  for (const [method, descriptor] of Object.entries(spec)) {
    switch (descriptor.kind) {
      case "request":
        client[method] = (...args) => transport.request<never[], never>(descriptor.channel, args);
        break;
      case "notify":
        client[method] = (...args) => transport.notify(descriptor.channel, args);
        break;
      case "event":
        client[method] = (...args) => transport.on(descriptor.channel, args[0]);
        break;
    }
  }

  return client as ChannelClient<Spec>;
}
