import { Minus } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { displayLabel, stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { type PendingDialog, useExtensionUiStore } from "../../stores/extension-ui";
import { useSessionControlStatus } from "../../stores/session-control";
import { SessionControlStatus } from "../session-control/SessionControlStatus";
import { QuestionCard } from "./QuestionCard";

/**
 * Extension UI dialogs: select / confirm / input /
 * editor requests block the agent, so closing without an answer must send
 * cancelled:true. Dialogs queue and render one at a time.
 */
export function ExtensionDialogs() {
	const dialogs = useExtensionUiStore((s) => s.dialogs);
	const minimizedDialogIds = useExtensionUiStore((s) => s.minimizedDialogIds);
	const dialog = dialogs.find((d) => !minimizedDialogIds[d.request.id]);
	if (!dialog) return null;
	return <DialogView key={dialog.request.id} dialog={dialog} />;
}

function DialogView({ dialog }: { dialog: PendingDialog }) {
	const request = dialog.request;
	const [value, setValue] = useState<string>("");
	const [selected, setSelected] = useState<string | null>(null);
	const [editorText, setEditorText] = useState(
		request.method === "editor" ? stripAnsi(request.prefill ?? "") : "",
	);

	const respond = useExtensionUiStore((s) => s.respond);
	const minimize = useExtensionUiStore((s) => s.minimize);
	const controlStatus = useSessionControlStatus(dialog.sessionHandle);
	const canControl = controlStatus.canControl;
	const [secondsLeft, setSecondsLeft] = useState<number | null>(() => {
		if (!dialog.deadlineAt) return null;
		return Math.max(0, Math.ceil((dialog.deadlineAt - Date.now()) / 1000));
	});

	useEffect(() => {
		if (!dialog.deadlineAt) return;
		const update = () => {
			setSecondsLeft(Math.max(0, Math.ceil((dialog.deadlineAt! - Date.now()) / 1000)));
		};
		update();
		const interval = setInterval(update, 1000);
		return () => clearInterval(interval);
	}, [dialog.deadlineAt]);

	const cancel = () => {
		if (!canControl) return;
		if (useExtensionUiStore.getState().minimizedDialogIds[request.id]) return;
		if (useExtensionUiStore.getState().dialogs.some((d) => d.request.id === request.id)) {
			respond(dialog, { type: "extension_ui_response", id: request.id, cancelled: true });
		}
	};

	const confirm = () => {
		if (!canControl) return;
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

	const body = request.method === "confirm" ? stripAnsi(request.message) : "";

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) cancel();
			}}
		>
			<DialogContent
				className={request.method === "editor" ? "max-w-2xl" : "max-w-md"}
				showCloseButton={canControl}
				onInteractOutside={(event) => {
					if (request.method === "editor" || !canControl) event.preventDefault();
				}}
			>
				<DialogHeader>
					<div className="flex items-center justify-between">
						<DialogTitle>{displayLabel(request.title)}</DialogTitle>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="-mr-1 size-7 text-ink-3 hover:text-ink"
									aria-label={tt("ext.minimize")}
									onClick={() => minimize(request.id)}
								>
									<Minus className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{tt("ext.minimize")}</TooltipContent>
						</Tooltip>
					</div>
					{body && <DialogDescription>{body}</DialogDescription>}
				</DialogHeader>
				<SessionControlStatus sessionHandle={dialog.sessionHandle} surface="extension" showNotice={false} />

				{request.method === "select" && (
					<QuestionCard
						options={request.options}
						selectedValue={selected}
						onSelect={setSelected}
						disabled={!canControl || dialog.responding}
					/>
				)}

				{request.method === "input" && (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ext-input">{tt("ext.input")}</Label>
						<Input
							id="ext-input"
							autoFocus={canControl}
							value={value}
							placeholder={request.placeholder ? displayLabel(request.placeholder) : undefined}
							onChange={(event) => setValue(event.target.value)}
							disabled={!canControl || dialog.responding}
							onKeyDown={(event) => {
								if (event.key === "Enter") confirm();
							}}
						/>
					</div>
				)}

				{request.method === "editor" && (
					<Textarea
						autoFocus={canControl}
						value={editorText}
						onChange={(event) => setEditorText(event.target.value)}
						disabled={!canControl || dialog.responding}
						rows={14}
						className="font-mono text-[13px] leading-[20px]"
					/>
				)}

				{secondsLeft !== null && (
					<p className="text-[12px] text-ink-3">{tt("ext.dialogDeadline", { seconds: secondsLeft })}</p>
				)}
				{"timeout" in request && request.timeout !== undefined && (
					<p className="text-[12px] text-ink-3">{tt("ext.timeoutHint")}</p>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={cancel} disabled={!canControl || dialog.responding}>
						{tt("common.cancel")}
					</Button>
					<Button
						onClick={confirm}
						disabled={!canControl || dialog.responding || (request.method === "select" && selected === null)}
					>
						{request.method === "confirm" ? tt("common.ok") : tt("common.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
