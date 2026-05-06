export class AsyncQueue<T> implements AsyncIterable<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
	private closed = false;
	private failure?: Error;

	push(value: T) {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value, done: false });
			return;
		}
		this.values.push(value);
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		while (this.waiters.length > 0) {
			this.waiters.shift()?.({ value: undefined as T, done: true });
		}
	}

	fail(error: Error) {
		if (this.closed) return;
		this.failure = error;
		this.closed = true;
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (!waiter) continue;
			waiter({ value: undefined as T, done: true });
		}
	}

	async next(): Promise<IteratorResult<T>> {
		if (this.failure) throw this.failure;
		const value = this.values.shift();
		if (value !== undefined) return { value, done: false };
		if (this.closed) return { value: undefined as T, done: true };
		return await new Promise<IteratorResult<T>>((resolve) => {
			this.waiters.push(resolve);
		}).then((result) => {
			if (this.failure) throw this.failure;
			return result;
		});
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => this.next(),
		};
	}
}
