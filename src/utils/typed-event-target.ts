/**
 * Typed event system for better type safety when using the EventTarget API.
 * This provides strongly-typed event dispatching and handling.
 */

/**
 * Extends the CustomEvent interface to provide better typing for event details
 */
export interface TypedCustomEvent<TDetail> extends CustomEvent {
  readonly detail: TDetail;
}

/**
 * A base class extending EventTarget to provide type safety for events.
 * TEventMap is a record mapping event names to their respective payload types.
 */
export class TypedEventTarget<TEventMap extends Record<string, any>> extends EventTarget {
  /**
   * Add an event listener with proper typing for the event detail
   * 
   * Method overloads to maintain compatibility with EventTarget while providing type safety
   */
  // @ts-expect-error
  public addEventListener<K extends keyof TEventMap>(
    type: K, 
    listener: (event: TypedCustomEvent<TEventMap[K]>) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  // @ts-expect-error
  public addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, callback, options);
  }

  /**
   * Remove an event listener with proper typing for the event detail
   * 
   * Method overloads to maintain compatibility with EventTarget while providing type safety
   */
  // @ts-expect-error
  public removeEventListener<K extends keyof TEventMap>(
    type: K,
    listener: (event: TypedCustomEvent<TEventMap[K]>) => void,
    options?: boolean | EventListenerOptions
  ): void;
  // @ts-expect-error
  public removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void {
    super.removeEventListener(type, callback, options);
  }

  /**
   * Dispatch an event with type checking for the event detail
   */
  protected dispatchTypedEvent<K extends keyof TEventMap>(
    type: K,
    detail: TEventMap[K]
  ): boolean {
    return super.dispatchEvent(new CustomEvent(type as string, { detail }));
  }
}