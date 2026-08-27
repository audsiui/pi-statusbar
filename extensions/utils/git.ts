import { execFile } from "node:child_process";

export function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			args,
			{
				cwd,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
				timeout: 2500,
			},
			(err, stdout) => {
				resolvePromise(err ? "" : stdout);
			},
		);
	});
}

export function parseGitStatus(out: string): { staged: number; modified: number } {
	let staged = 0;
	let modified = 0;
	for (const line of out.split("\n")) {
		if (line.length < 2) continue;
		const x = line[0];
		const y = line[1];
		if (x !== " " && x !== "?") staged++;
		if (y !== " " && y !== "?") modified++;
	}
	return { staged, modified };
}
