import { assert, expect, test } from 'vitest';
import { createTestEvent, withRequestContext, callRemote } from './index.js';
import { echo, say_ok, greeting_form } from './fixtures/sample.remote.js';

test('can import and call remote functions from a .remote.js file', async () => {
	const event = createTestEvent();

	const echo_result = await withRequestContext(event, () => echo('hello'));
	assert.equal(echo_result, 'hello');
});

test('transform sets __.name so error messages include function names', () => {
	const event = createTestEvent({ method: 'GET' });

	// commands require a mutative method (POST/PUT/PATCH/DELETE) — calling with
	// GET throws an error that includes the function name
	try {
		withRequestContext(event, () => say_ok());
		assert.fail('should have thrown');
	} catch (e) {
		assert.ok(e instanceof Error);
		// Without the transform, __.name is '' and the error reads:
		//   "Cannot call a command (`()`) from a GET handler"
		// With the transform, the function name is injected:
		//   "Cannot call a command (`say_ok()`) from a GET handler"
		assert.match(e.message, /Cannot call a command \(`say_ok\(\)`\)/);
	}
});

test('callRemote handles form submission with valid data', async () => {
	const output = await callRemote(greeting_form, { name: 'Alice' });

	assert.equal(output.submission, true);
	expect(output.result).toEqual({ greeting: 'Hello, Alice!' });
	assert.equal(output.issues, undefined);
});

test('callRemote handles form validation failure without throwing', async () => {
	// Forms don't throw on validation failure — they return issues on the output.
	// This matches actual form behavior (inline validation errors in UI).
	const output = await callRemote(greeting_form, { bad: 'data' });

	assert.equal(output.submission, true);
	assert.ok(output.issues);
	assert.ok(output.issues.length > 0);
	assert.equal(output.issues[0].message, 'name is required');
});
