const DEFAULT_OUTBOUND_TIMEOUT_MS = Number.parseInt(process.env.PI_SPEAK_OUTBOUND_TIMEOUT_MS || "30000", 10);

export async function withAbortTimeout<T>(
	callback: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
	timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS,
) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return callback(signal ?? new AbortController().signal);
	}

	const timeoutController = new AbortController();
	const timeoutHandle = setTimeout(() => timeoutController.abort(new Error("Outbound request timed out")), timeoutMs);
	timeoutHandle.unref?.();

	try {
		return await callback(anySignal([signal, timeoutController.signal]));
	} finally {
		clearTimeout(timeoutHandle);
	}
}

function anySignal(signals: Array<AbortSignal | undefined>) {
	const activeSignals = signals.filter((candidate): candidate is AbortSignal => !!candidate);
	if (activeSignals.length === 0) return new AbortController().signal;
	if (activeSignals.length === 1) return activeSignals[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(activeSignals);

	const combined = new AbortController();
	for (const candidate of activeSignals) {
		if (candidate.aborted) {
			combined.abort(candidate.reason);
			return combined.signal;
		}
		candidate.addEventListener(
			"abort",
			() => {
				if (!combined.signal.aborted) combined.abort(candidate.reason);
			},
			{ once: true },
		);
	}
	return combined.signal;
}
