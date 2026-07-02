import { Toaster as Sonner } from "sonner";
import { useTheme } from "../../lib/use-theme";

function Toaster({ ...props }: React.ComponentProps<typeof Sonner>) {
	const { resolved } = useTheme();
	return (
		<Sonner
			theme={resolved}
			position="top-center"
			toastOptions={{
				classNames: {
					toast: "!rounded-md !border-border !bg-surface !text-ink !shadow-lv2 !font-sans",
					description: "!text-ink-2",
				},
			}}
			{...props}
		/>
	);
}

export { Toaster };
