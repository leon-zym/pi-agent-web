import { Check } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { type PendingDialog, useExtensionUiStore } from "../../stores/extension-ui";
import { useSessionControlStore } from "../../stores/session-control";

/**
 * Extension UI dialogs: select / confirm / input /
 * editor requests block the agent, so closing without an answer must send
 * cancelled:true. Dialogs queue and render one at a time.
 */
export function ExtensionDialogs() {
	const dialogs = useExtensionUiStore((s) => s.dialogs);
	const dialog = dialogs[0];
	const canControl = useSessionControlStore((s) => s.canControl(dialog?.workspaceId ?? null));
	if (!dialog || !canControl) return null;
	return <DialogView key={dialog.request.id} dialog={dialog} />;
}

function DialogView({ dialog }: { dialog: PendingDialog }) {
	const request = dialog.request;
	const [value, setValue] = useState<string>("");
	const [selected, setSelected] = useState<string | null>(null);
	const [editorText, setEditorText] = useState(request.method === "editor" ? (request.prefill ?? "") : "");

	const respond = useExtensionUiStore((s) => s.respond);
	const canControl = useSessionControlStore((s) => s.canControl(dialog.workspaceId));

	const cancel = () => {
		if (useExtensionUiStore.getState().dialogs.some((d) => d.request.id === request.id)) {
			respond(dialog, { type: "extension_ui_response", id: request.id, cancelled: true });
		}
	};

	const confirm = () => {
		if (request.method === "select") {
			if (selected === null) return;
			respond(dialog, { type: "extension_ui_response", id: request.id, value: selected });
		} else if (request.method === "confirm") {
			respond(dialog, { type: "extension_ui_response", id: request.id, confirmed: true });
		} else {
			respond(dialog, {
				type: "extension_ui_response",
				id: request.id,
				value: request.method === "editor" ? editorText : value,
			});
		}
	};

	const body = request.method === "confirm" ? request.message : "";

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) cancel();
			}}
		>
			<DialogContent
				className={request.method === "editor" ? "max-w-2xl" : "max-w-md"}
				onInteractOutside={(event) => {
					if (request.method === "editor") event.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>{request.title}</DialogTitle>
					{body && <DialogDescription>{body}</DialogDescription>}
				</DialogHeader>

				{request.method === "select" && (
					<div className="flex flex-col gap-0.5">
						{request.options.map((option) => (
							<button
								key={option}
								type="button"
								onClick={() => setSelected(option)}
								disabled={!canControl}
								className={cn(
									"flex items-center gap-2 rounded-sm px-2 py-2 text-left text-[14px] transition-colors hover:bg-hover",
									selected === option ? "bg-hover text-ink" : "text-ink-2",
								)}
							>
								<span
									className={cn(
										"flex size-4 shrink-0 items-center justify-center rounded-full border",
										selected === option ? "border-primary bg-primary" : "border-border-strong",
									)}
								>
									{selected === option && <Check className="size-3 text-white" />}
								</span>
								{option}
							</button>
						))}
					</div>
				)}

				{request.method === "input" && (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ext-input">{tt("ext.input")}</Label>
						<Input
							id="ext-input"
							autoFocus
							value={value}
							placeholder={request.placeholder}
							onChange={(event) => setValue(event.target.value)}
							disabled={!canControl}
							onKeyDown={(event) => {
								if (event.key === "Enter") confirm();
							}}
						/>
					</div>
				)}

				{request.method === "editor" && (
					<Textarea
						autoFocus
						value={editorText}
						onChange={(event) => setEditorText(event.target.value)}
						disabled={!canControl}
						rows={14}
						className="font-mono text-[13px] leading-[20px]"
					/>
				)}

				{"timeout" in request && request.timeout !== undefined && (
					<p className="text-[12px] text-ink-3">{tt("ext.timeoutHint")}</p>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={cancel} disabled={!canControl}>
						{tt("common.cancel")}
					</Button>
					<Button
						onClick={confirm}
						disabled={!canControl || (request.method === "select" && selected === null)}
					>
						{request.method === "confirm" ? tt("common.ok") : tt("common.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
