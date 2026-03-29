import { query, command } from '$app/server';

export const echo = query('unchecked', (/** @type {string} */ value) => value);

export const say_ok = command(() => {
	return 'ok';
});
