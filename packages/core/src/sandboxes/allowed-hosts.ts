import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { sandboxAllowedHost } from "../database/schema.ts";

/**
 * What every workspace's sandboxes may reach: where source code is hosted and
 * the package registries agents install from. A wildcard leaves its domain
 * out, so a domain wanted with its subdomains is listed twice.
 */
export const TRUSTED_HOSTS: readonly string[] = [
	"github.com",
	"*.github.com",
	"*.githubusercontent.com",
	"ghcr.io",
	"gitlab.com",
	"bitbucket.org",
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"*.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
	"rubygems.org",
	"*.rubygems.org",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"deb.debian.org",
	"security.debian.org",
	"archive.ubuntu.com",
	"security.ubuntu.com",
	"ports.ubuntu.com",
];

/** The hosts the workspace added beyond {@link TRUSTED_HOSTS}, oldest first. */
export const addedHostsOf = (workspaceId: string) =>
	query((db) =>
		db
			.select()
			.from(sandboxAllowedHost)
			.where(eq(sandboxAllowedHost.workspaceId, workspaceId))
			.orderBy(asc(sandboxAllowedHost.createdAt), asc(sandboxAllowedHost.host)),
	);

/** Every host the workspace's sandboxes may reach. */
export const allowedHostsOf = (workspaceId: string) =>
	Effect.map(addedHostsOf(workspaceId), (added) => [
		...new Set([...TRUSTED_HOSTS, ...added.map((row) => row.host)]),
	]);
