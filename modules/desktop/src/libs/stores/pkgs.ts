import { writable } from "svelte/store";
import type { GUIPackage, InstalledPackage } from "../types";
import { PackageStates } from "../types";
import Fuse from "fuse.js";
import {
	getPackage,
	getDistPackages,
	getInstalledPackages,
	installPackage,
	getPackageBottles
} from "@native";

import { getReadme, getContributors, getRepoAsPackage } from "$libs/github";
import type { Package } from "@tea/ui/types";
import { trackInstall, trackInstallFailed } from "$libs/analytics";

const log = window.require("electron-log");

export default function initPackagesStore() {
	let initialized = false;
	const syncProgress = writable<number>(0); // TODO: maybe use this in the UI someday
	const packages = writable<GUIPackage[]>([]);
	const requireTeaCli = writable<boolean>(false);

	let packagesIndex: Fuse<GUIPackage>;

	const updatePackage = (full_name: string, props: Partial<GUIPackage>) => {
		packages.update((pkgs) => {
			const i = pkgs.findIndex((pkg) => pkg.full_name === full_name);
			if (i >= 0) {
				pkgs[i] = {
					...pkgs[i],
					...props
				};
			}
			return pkgs;
		});
	};

	const syncPackageData = async (guiPkg: Partial<GUIPackage> | undefined) => {
		if (!guiPkg || guiPkg.synced) return;

		const pkg = await getPackage(guiPkg.full_name!); // ATM: pkg only bottles and github:string
		const readmeMd = `# ${guiPkg.full_name} #
To read more about this package go to [${guiPkg.homepage}](${guiPkg.homepage}).
		`;

		const updatedPackage: Partial<GUIPackage> = {
			...pkg,
			readme_md: readmeMd,
			synced: true
		};
		if (pkg.github) {
			const [owner, repo] = pkg.github.split("/");
			const [readme, contributors, repoData] = await Promise.all([
				getReadme(owner, repo),
				getContributors(owner, repo),
				getRepoAsPackage(owner, repo)
			]);
			if (readme) {
				updatedPackage.readme_md = readme;
			}
			updatedPackage.contributors = contributors;
			updatedPackage.license = repoData.license;
		}

		updatePackage(guiPkg.full_name!, updatedPackage);
	};

	const checkTeaCLIPackage = async (teaPkg: Package, installedPkg?: InstalledPackage) => {
		if (!installedPkg) {
			requireTeaCli.set(true);
			return;
		}

		const isUpToDate = teaPkg.version === installedPkg?.installed_versions[0];
		log.info("check if Tea-CLI is up to date:", isUpToDate);
	};

	const init = async function () {
		log.info("packages store: try initialize");
		if (!initialized) {
			log.info("packages store: initializing...");
			initialized = true;
			const pkgs = await getDistPackages();
			const guiPkgs: GUIPackage[] = pkgs.map((p) => ({
				...p,
				state: PackageStates.AVAILABLE
			}));

			// set packages data so that i can render something in the UI already
			packages.set(guiPkgs);
			log.info("initialized packages store with ", guiPkgs.length);
			packagesIndex = new Fuse(guiPkgs, {
				keys: ["name", "full_name", "desc", "categories"]
			});
			log.info("initialized packages fuse index");

			try {
				const installedPkgs: InstalledPackage[] = await getInstalledPackages();

				log.info("sync test for tea-cli");
				const distTea = pkgs.find((p) => p.full_name === "tea.xyz");
				const installedTeaPkg = installedPkgs.find((p) => p.full_name === "tea.xyz");
				if (distTea) await checkTeaCLIPackage(distTea, installedTeaPkg);

				log.info("set NEEDS_UPDATE state to pkgs");
				for (const [i, iPkg] of installedPkgs.entries()) {
					const pkg = guiPkgs.find((p) => p.full_name === iPkg.full_name);
					if (pkg) {
						const isUpdated = pkg.version === iPkg.installed_versions[0];
						updatePackage(pkg.full_name, {
							installed_versions: iPkg.installed_versions,
							state: isUpdated ? PackageStates.INSTALLED : PackageStates.NEEDS_UPDATE
						});
					}
					syncProgress.set(+((i + 1) / installedPkgs.length).toFixed(2));
				}
			} catch (error) {
				log.error(error);
			}
		}
		log.info("packages store: initialized!");
	};

	const installPkg = async (pkg: GUIPackage, version?: string) => {
		let fakeTimer: NodeJS.Timer | null = null;
		try {
			const state: PackageStates =
				pkg.state === PackageStates.NEEDS_UPDATE
					? PackageStates.UPDATING
					: PackageStates.INSTALLING;

			updatePackage(pkg.full_name, { state });

			fakeTimer = withFakeLoader(pkg, (progress) => {
				updatePackage(pkg.full_name, { install_progress_percentage: progress });
			});

			await installPackage(pkg, version || pkg.version);
			trackInstall(pkg.full_name);
			updatePackage(pkg.full_name, { state: PackageStates.INSTALLED });
		} catch (error) {
			let message = "Unknown Error";
			if (error instanceof Error) message = error.message;
			trackInstallFailed(pkg.full_name, message || "unknown");
		} finally {
			fakeTimer && clearTimeout(fakeTimer);
			updatePackage(pkg.full_name, { install_progress_percentage: 100 });
		}
	};

	const fetchPackageBottles = async (pkgName: string) => {
		// TODO: this api should take an architecture argument or else an architecture filter should be applied downstreawm
		const bottles = await getPackageBottles(pkgName);
		updatePackage(pkgName, { bottles });
	};

	return {
		packages,
		syncProgress,
		requireTeaCli,
		subscribe: packages.subscribe,
		search: async (term: string, limit = 5): Promise<GUIPackage[]> => {
			if (!term || !packagesIndex) return [];
			// TODO: if online, use algolia else use Fuse
			const res = packagesIndex.search(term, { limit });
			const matchingPackages: GUIPackage[] = res.map((v) => v.item);
			return matchingPackages;
		},
		subscribeToPackage: (slug: string, cb: (pkg: GUIPackage) => void) => {
			packages.subscribe((pkgs) => {
				const foundPackage = pkgs.find((p) => p.slug === slug) as GUIPackage;
				if (foundPackage) {
					cb(foundPackage);
					syncPackageData(foundPackage);
				}
			});
		},
		fetchPackageBottles,
		updatePackage,
		init,
		installPkg,
		syncPackageData
	};
}

const withFakeLoader = (pkg: GUIPackage, callback: (progress: number) => void): NodeJS.Timer => {
	let fakeLoadingProgress = 1;
	const ms = 100;
	const assumedDlSpeedMb = 1024 * 1024 * 3; // 3mbps
	const size = pkg?.bottles?.length ? pkg.bottles[0].bytes : assumedDlSpeedMb * 10;
	const eta = size / assumedDlSpeedMb;

	const increment = 1 / eta / 10;

	const fakeTimer = setInterval(() => {
		const progressLeft = 100 - fakeLoadingProgress;
		const addProgress = progressLeft * increment;
		fakeLoadingProgress = fakeLoadingProgress + addProgress;
		callback(+fakeLoadingProgress.toFixed(2));
	}, ms);

	return fakeTimer;
};
