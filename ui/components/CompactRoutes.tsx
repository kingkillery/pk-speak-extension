import React from "react";
import { Box, Text } from "ink";
import type { CompactRouteSlot } from "../../session-routing.js";

export type CompactRoutesProps = {
	slots: CompactRouteSlot[];
};

function slotColor(slot: CompactRouteSlot): string | undefined {
	if (slot.status === "mapped") return "green";
	if (slot.status === "ambiguous") return "yellow";
	return undefined;
}

function slotText(slot: CompactRouteSlot): string {
	if (slot.status === "mapped") {
		const labels = slot.labels.length > 0 ? ` via ${slot.labels.join(", ")}` : "";
		return `${slot.family}: ${slot.sessionName}${labels}`;
	}
	if (slot.status === "ambiguous") {
		return `${slot.family}: ambiguous (${slot.labels.join(", ") || "multiple mappings"})`;
	}
	return `${slot.family}: unassigned`;
}

export function CompactRoutes({ slots }: CompactRoutesProps) {
	return (
		<Box marginTop={1} flexDirection="column">
			<Text bold>Compact routes</Text>
			{slots.map((slot) => (
				<Text key={`slot-${slot.family}`} color={slotColor(slot)}>
					{slotText(slot)}
				</Text>
			))}
		</Box>
	);
}

export default CompactRoutes;
