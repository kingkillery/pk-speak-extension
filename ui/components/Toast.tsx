import React from "react";
import { Box, Text } from "ink";
import type { Toast as ToastShape } from "../hooks/useSessionStore.js";

export type ToastBandProps = {
	toasts: ToastShape[];
	maxVisible?: number;
};

function toastColor(source: ToastShape["source"]): string | undefined {
	if (source === "voice") return "magenta";
	if (source === "admin") return "cyan";
	return undefined;
}

export function renderToastLine(toast: ToastShape): string {
	return `${toast.source}: ${toast.message}`;
}

export function ToastBand({ toasts, maxVisible = 3 }: ToastBandProps) {
	if (!toasts || toasts.length === 0) return null;
	const visible = toasts.slice(-maxVisible);
	return (
		<Box flexDirection="column" marginTop={1}>
			{visible.map((toast) => (
				<Text key={toast.id} color={toastColor(toast.source)}>
					{renderToastLine(toast)}
				</Text>
			))}
		</Box>
	);
}

export default ToastBand;
