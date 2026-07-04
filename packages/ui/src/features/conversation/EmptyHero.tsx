import { Bot } from "lucide-react";
import { useSessionDirectoryStore } from "../../stores/session-directory";

/** Quiet empty state: no marketing hero, just orientation (DESIGN.md). */
export function EmptyHero() {
	const hasWorkspace = useSessionDirectoryStore((s) => s.currentWorkspaceId !== null);
	const hasSession = useSessionDirectoryStore((s) => s.currentSession !== null);

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
			<div className="flex size-12 items-center justify-center rounded-xl bg-primary-soft text-primary">
				<Bot className="size-6" />
			</div>
			<p className="text-base font-medium text-ink">
				{!hasWorkspace ? "打开一个工作区开始对话" : !hasSession ? "选择或新建一个会话" : "开始你的第一轮对话"}
			</p>
			<p className="max-w-sm text-[13px] leading-relaxed text-ink-3">
				输入消息发送给 Pi Coding Agent。运行中输入回车会以「插队」方式注入，Cmd/Ctrl + Enter
				排队到本轮结束后执行。
			</p>
		</div>
	);
}
