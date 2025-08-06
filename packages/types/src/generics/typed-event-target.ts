export interface TypedCustomEvent<TDetail> extends CustomEvent {
	readonly detail: TDetail;
}

export class TypedEventTarget<
	// biome-ignore lint/suspicious/noExplicitAny: This is a generic type for event mapping.
	TEventMap extends Record<string, any>,
> extends EventTarget {
	// @ts-expect-error
	public addEventListener<K extends keyof TEventMap>(
		type: K,
		listener: (event: TypedCustomEvent<TEventMap[K]>) => void,
		options?: boolean | AddEventListenerOptions,
	): void;
	// @ts-expect-error
	public addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		super.addEventListener(type, callback, options);
	}

	// @ts-expect-error
	public removeEventListener<K extends keyof TEventMap>(
		type: K,
		listener: (event: TypedCustomEvent<TEventMap[K]>) => void,
		options?: boolean | EventListenerOptions,
	): void;
	// @ts-expect-error
	public removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		super.removeEventListener(type, callback, options);
	}

	protected dispatchTypedEvent<K extends keyof TEventMap>(
		type: K,
		detail: TEventMap[K],
	): boolean {
		return super.dispatchEvent(new CustomEvent(type as string, { detail }));
	}
}
