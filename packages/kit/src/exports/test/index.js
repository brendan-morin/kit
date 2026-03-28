/** @import { RequestEvent, Cookies } from '@sveltejs/kit' */
/** @import { RequestState, RequestStore } from 'types' */
/** @import { StandardSchemaV1 } from '@standard-schema/spec' */

import { with_request_store } from '@sveltejs/kit/internal/server';
import { HttpError } from '@sveltejs/kit/internal';
import { noop_span } from '../../runtime/telemetry/noop.js';
import { get_cookies } from '../../runtime/server/cookie.js';

/**
 * An `HttpError` subclass thrown when a remote function's schema validation fails
 * during testing. Extends `HttpError` so `instanceof HttpError` checks still pass,
 * but also exposes the Standard Schema `.issues` for test assertions.
 */
export class HttpValidationError extends HttpError {
	/** @type {StandardSchemaV1.Issue[]} */
	issues;

	/**
	 * @param {number} status
	 * @param {App.Error} body
	 * @param {StandardSchemaV1.Issue[]} issues
	 */
	constructor(status, body, issues) {
		super(status, body);
		this.issues = issues;
	}
}

/**
 * Creates a mock `RequestEvent` for use in test environments.
 *
 * @param {object} [options]
 * @param {string} [options.url] The URL of the request. Defaults to `'http://localhost/'`.
 * @param {string} [options.method] The HTTP method. Defaults to `'GET'`.
 * @param {Record<string, string>} [options.headers] Request headers.
 * @param {App.Locals} [options.locals] Custom data for `event.locals`.
 * @param {Record<string, string>} [options.params] Route parameters.
 * @param {Record<string, string>} [options.cookies] Initial cookies as name-value pairs.
 * @param {Cookies} [options.cookiesObject] A full Cookies implementation (overrides `cookies`).
 * @param {string | null} [options.routeId] The route ID. Defaults to `'/'`.
 * @param {typeof fetch} [options.fetch] Custom fetch implementation.
 * @param {() => string} [options.getClientAddress] Custom client address function.
 * @param {Readonly<App.Platform>} [options.platform] Platform-specific data.
 * @param {BodyInit | null} [options.body] Request body.
 * @returns {RequestEvent}
 */
export function createTestEvent(options = {}) {
	const url = new URL(options.url ?? 'http://localhost/');
	const method = options.method ?? 'GET';

	// build cookie header from the initial cookies map, if provided
	const cookie_header = options.cookies
		? Object.entries(options.cookies)
				.map(([k, v]) => `${k}=${v}`)
				.join('; ')
		: '';

	const incoming_headers = new Headers(options.headers);
	if (cookie_header) {
		incoming_headers.set('cookie', cookie_header);
	}

	const request = new Request(url, {
		method,
		headers: incoming_headers,
		body: options.body ?? null
	});

	let cookies;
	if (options.cookiesObject) {
		cookies = options.cookiesObject;
	} else {
		const cookie_state = get_cookies(request, url);
		cookie_state.set_trailing_slash('never');
		cookies = cookie_state.cookies;
	}

	return /** @type {RequestEvent} */ ({
		cookies,
		fetch: options.fetch ?? globalThis.fetch,
		getClientAddress: options.getClientAddress ?? (() => '127.0.0.1'),
		locals: /** @type {App.Locals} */ (options.locals ?? {}),
		params: options.params ?? {},
		platform: options.platform,
		request,
		route: { id: options.routeId ?? '/' },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false,
		tracing: {
			enabled: false,
			root: noop_span,
			current: noop_span
		}
	});
}

/**
 * Wraps a function call in a SvelteKit request context, making `getRequestEvent()`
 * and remote functions (`query`, `command`, `form`) work inside the callback.
 *
 * If a remote function's schema validation fails, the resulting `HttpError` is caught
 * and rethrown as an `HttpValidationError` with the Standard Schema `.issues` attached.
 *
 * @template T
 * @param {RequestEvent} event The mock request event (use `createTestEvent` to create one)
 * @param {() => T} fn The function to execute within the request context
 * @param {object} [options]
 * @param {Record<string, { encode: (value: any) => any, decode: (value: any) => any }>} [options.transport] Custom transport encoders/decoders
 * @returns {T}
 */
export function withRequestContext(event, fn, options = {}) {
	/** @type {StandardSchemaV1.Issue[] | null} */
	let captured_issues = null;

	/** @type {RequestState} */
	const state = /** @type {RequestState} */ ({
		prerendering: undefined,
		transport: options.transport ?? {},
		// Production default returns { message: 'Bad Request' } and logs issues to console
		// (see runtime/server/index.js). We capture the issues here so we can rethrow as
		// HttpValidationError, giving test consumers typed access to validation failures.
		handleValidationError: ({ issues }) => {
			captured_issues = issues;
			return { message: 'Bad Request' };
		},
		tracing: {
			record_span: ({ fn }) => fn(noop_span)
		},
		remote: {
			data: null,
			forms: null,
			refreshes: null
		},
		is_in_remote_function: false,
		is_in_render: false,
		is_in_universal_load: false
	});

	/** @type {RequestStore} */
	const store = { event, state };

	/**
	 * If an HttpError was thrown after handleValidationError captured issues,
	 * rethrow as HttpValidationError so tests get typed access to .issues.
	 * @param {unknown} e
	 * @returns {never}
	 */
	function maybe_rethrow_validation(e) {
		if (captured_issues && e instanceof HttpError) {
			throw new HttpValidationError(e.status, e.body, captured_issues);
		}
		throw e;
	}

	try {
		const result = with_request_store(store, fn);

		// handle async — the fn may return a promise that rejects with a validation error
		if (result != null && typeof (/** @type {any} */ (result).then) === 'function') {
			return /** @type {T} */ (
				/** @type {any} */ (result).then(undefined, maybe_rethrow_validation)
			);
		}

		return result;
	} catch (e) {
		maybe_rethrow_validation(e);
	}
}
