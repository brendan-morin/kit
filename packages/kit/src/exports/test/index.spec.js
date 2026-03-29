import { assert, expect, test } from 'vitest';
import { createTestEvent, withRequestContext, callRemote, HttpValidationError } from './index.js';
import { getRequestEvent } from '@sveltejs/kit/internal/server';
import { query } from '../../runtime/app/server/remote/query.js';
import { command } from '../../runtime/app/server/remote/command.js';
import { HttpError } from '@sveltejs/kit/internal';

test('createTestEvent produces a valid RequestEvent with defaults', () => {
	const event = createTestEvent();

	assert.ok(event.url instanceof URL);
	assert.equal(event.url.href, 'http://localhost/');
	assert.equal(event.request.method, 'GET');
	assert.equal(event.isDataRequest, false);
	assert.equal(event.isSubRequest, false);
	assert.equal(event.isRemoteRequest, false);
	assert.equal(event.route.id, '/');
	assert.equal(typeof event.getClientAddress, 'function');
	assert.equal(event.getClientAddress(), '127.0.0.1');
	assert.equal(typeof event.setHeaders, 'function');
	assert.equal(typeof event.fetch, 'function');
	assert.ok(event.cookies);
	assert.ok(event.tracing);
	assert.equal(event.tracing.enabled, false);
});

test('createTestEvent applies custom options', () => {
	const event = createTestEvent({
		url: 'http://example.com/blog/hello',
		method: 'POST',
		locals: { user: { id: '123' } },
		params: { slug: 'hello' },
		cookies: { session: 'abc' },
		routeId: '/blog/[slug]'
	});

	assert.equal(event.url.pathname, '/blog/hello');
	assert.equal(event.request.method, 'POST');
	expect(event.locals).toEqual({ user: { id: '123' } });
	expect(event.params).toEqual({ slug: 'hello' });
	assert.equal(event.cookies.get('session'), 'abc');
	assert.equal(event.route.id, '/blog/[slug]');
});

test('withRequestContext makes getRequestEvent() succeed', () => {
	// without context, getRequestEvent throws
	assert.throws(() => getRequestEvent(), /Can only read the current request event/);

	// with context, it returns the event
	const event = createTestEvent({ locals: { test_value: 42 } });

	const result = withRequestContext(event, () => {
		const req = getRequestEvent();
		return req.locals;
	});

	expect(result).toEqual({ test_value: 42 });
});

test('withRequestContext propagates return value', () => {
	const event = createTestEvent();

	const result = withRequestContext(event, () => 'hello from test');

	assert.equal(result, 'hello from test');
});

test('withRequestContext works with async', async () => {
	const event = createTestEvent({ locals: { async_test: true } });

	const result = await withRequestContext(event, async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		const req = getRequestEvent();
		return req.locals;
	});

	expect(result).toEqual({ async_test: true });
});

test('withRequestContext allows calling a real query() remote function', async () => {
	// basic remote function
	const get_query = query(() => {
		return true;
	});

	// without test event, calling a remote function in a test results in an error
	assert.throws(() => get_query(), /Could not get the request store/);

	// with a test event + request context, we can now successfully test remote functions
	const event = createTestEvent({ url: 'http://localhost/blog/hello' });
	const result = await withRequestContext(event, () => get_query());

	assert.equal(result, true);
});

test('withRequestContext surfaces validation errors from schema-validated remote functions', async () => {
	// avoid a dev dependency on a validation library
	const schema = /** @type {import('@standard-schema/spec').StandardSchemaV1<string>} */ ({
		'~standard': {
			validate: (/** @type {unknown} */ value) => {
				if (typeof value !== 'string') {
					return { issues: [{ message: 'Expected a string' }] };
				}
				return { value };
			}
		}
	});

	const validated_query = query(schema, (arg) => {
		return arg.toUpperCase();
	});

	const event = createTestEvent();

	// valid input succeeds
	const result = await withRequestContext(event, () => validated_query('hello'));
	assert.equal(result, 'HELLO');

	// invalid input throws an HttpValidationError with status 400 and typed issues
	try {
		await withRequestContext(event, () => validated_query(/** @type {any} */ (123)));
		assert.fail('should have thrown');
	} catch (e) {
		// HttpValidationError extends HttpError, so both checks pass
		assert.ok(e instanceof HttpValidationError);
		assert.ok(e instanceof HttpError);
		assert.equal(e.status, 400);
		assert.equal(e.body.message, 'Bad Request');
		expect(e.issues).toEqual([{ message: 'Expected a string' }]);
	}
});

test('callRemote auto-detects GET for queries', async () => {
	const my_query = query('unchecked', (/** @type {string} */ val) => val.toUpperCase());
	const result = await callRemote(my_query, 'hello');
	assert.equal(result, 'HELLO');
});

test('callRemote auto-detects POST for commands', async () => {
	const my_command = command('unchecked', (/** @type {number} */ n) => n * 2);
	const result = await callRemote(my_command, 5);
	assert.equal(result, 10);
});
