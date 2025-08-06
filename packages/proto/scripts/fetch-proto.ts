/** biome-ignore-all lint/suspicious/noExplicitAny: is difficult to handle dynamic ast types*/
import { promises as fs } from "node:fs";
import type { Node } from "acorn";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

let whatsAppVersion = "latest";

const addPrefix = (lines: string[], prefix: string): string[] =>
	lines.map((line) => prefix + line);

type ExpressionNode = Node & {
	expression?: ExpressionNode & {
		arguments?: ExpressionNode[];
		expressions?: ExpressionNode[];
	};
	body?: { body: ExpressionNode[] };
};

const extractAllExpressions = (node: ExpressionNode): ExpressionNode[] => {
	const expressions = [node];
	if (node?.expression) {
		expressions.push(node.expression);
		if (Array.isArray(node.expression.arguments)) {
			for (const arg of node.expression.arguments) {
				if (Array.isArray(arg?.body?.body)) {
					for (const exp of arg.body.body) {
						expressions.push(...extractAllExpressions(exp));
					}
				}
			}
		}
		if (Array.isArray(node.expression.expressions)) {
			for (const exp of node.expression.expressions) {
				expressions.push(...extractAllExpressions(exp));
			}
		}
	}
	if (Array.isArray(node?.body?.body)) {
		for (const exp of node.body.body) {
			if (exp.expression) {
				expressions.push(...extractAllExpressions(exp.expression));
			}
		}
	}
	return expressions;
};

interface ModuleInfo {
	crossRefs: { alias: string; module: string }[];
	identifiers?: Record<string, any>;
}

interface ModuleIndentationMap {
	[key: string]: {
		indentation?: string;
		members?: Set<string>;
	};
}

async function findAppModules(): Promise<any[]> {
	const headers = {
		"User-Agent":
			"Mozilla/5.0 (X11; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0",
		"Sec-Fetch-Dest": "script",
		"Sec-Fetch-Mode": "no-cors",
		"Sec-Fetch-Site": "same-origin",
		Referer: "https://web.whatsapp.com/",
		Accept: "*/*",
		"Accept-Language": "en-US,en;q=0.5",
	};
	const baseURL = "https://web.whatsapp.com";
	const serviceworkerResp = await fetch(`${baseURL}/sw.js`, { headers });
	const serviceworker = await serviceworkerResp.text();

	const versionMatch = [
		...serviceworker.matchAll(/client_revision\\":([\d.]+),/g),
	];
	const version = versionMatch[0]?.[1];
	console.log(`Current version: 2.3000.${version}`);

	whatsAppVersion = `2.3000.${version}`;

	const clearString = serviceworker.replaceAll("/*BTDS*/", "");
	const URLScript = clearString.match(
		/(?<=importScripts\(["'])(.*?)(?=["']\);)/g,
	);
	if (!URLScript?.[0]) {
		throw new Error("Could not find importScripts URL in service worker");
	}
	const bootstrapQRURL = new URL(URLScript[0].replaceAll("\\", "")).href;

	console.info("Found source JS URL:", bootstrapQRURL);

	const qrDataResp = await fetch(bootstrapQRURL, { headers });
	const qrData = await qrDataResp.text();

	const patchedQrData = qrData.replace(
		"t.ActionLinkSpec=void 0,t.TemplateButtonSpec",
		"t.ActionLinkSpec=t.TemplateButtonSpec",
	);

	const qrModules = (
		acorn.parse(patchedQrData, { ecmaVersion: "latest" }) as any
	).body;

	return qrModules.filter((m: ExpressionNode) =>
		extractAllExpressions(m)?.some(
			(e: any) => e?.left?.property?.name === "internalSpec",
		),
	);
}

export const generateProto = async () => {
	const unspecName = (name: string): string =>
		name.endsWith("Spec") ? name.slice(0, -4) : name;
	const unnestName = (name: string): string =>
		name.split("$").slice(-1)[0] ?? "";
	const getNesting = (name: string): string =>
		name.split("$").slice(0, -1).join("$");
	const makeRenameFunc =
		() =>
		(name: string): string => {
			const unspecedName = unspecName(name);
			return unspecName(unspecedName);
		};

	const modules = await findAppModules();

	const modulesInfo: Record<string, ModuleInfo> = {};
	const moduleIndentationMap: ModuleIndentationMap = {};
	for (const module of modules) {
		const moduleName: string = module.expression.arguments[0].value;
		modulesInfo[moduleName] = { crossRefs: [] };
		walk.simple(module, {
			AssignmentExpression(node: Node) {
				if (
					node &&
					(node as any)?.right?.type === "CallExpression" &&
					(node as any)?.right?.arguments?.length === 1 &&
					(node as any)?.right?.arguments[0].type !== "ObjectExpression"
				) {
					if (modulesInfo[moduleName]) {
						modulesInfo[moduleName].crossRefs.push({
							alias: (node as any).left.name,
							module: (node as any).right.arguments[0].value,
						});
					}
				}
			},
		});
	}

	for (const mod of modules) {
		const modInfo = modulesInfo[mod.expression.arguments[0].value];
		const rename = makeRenameFunc();

		const assignments: any[] = [];
		walk.simple(mod, {
			AssignmentExpression(node: any) {
				const left = node.left;
				if (
					left.property?.name &&
					left.property?.name !== "internalSpec" &&
					left.property?.name !== "internalDefaults"
				) {
					assignments.push(left);
				}
			},
		});

		const makeBlankIdent = (a: any): [string, any] => {
			const key = rename(a?.property?.name);
			const indentation = getNesting(key);
			const value = { name: key };

			moduleIndentationMap[key] = moduleIndentationMap[key] || {};
			moduleIndentationMap[key].indentation = indentation;

			if (indentation.length) {
				moduleIndentationMap[indentation] =
					moduleIndentationMap[indentation] || {};
				moduleIndentationMap[indentation].members =
					moduleIndentationMap[indentation].members || new Set();
				moduleIndentationMap[indentation].members?.add(key);
			}

			return [key, value];
		};
		if (modInfo) {
			modInfo.identifiers = Object.fromEntries(
				assignments.map(makeBlankIdent).reverse(),
			);
		}

		const enumAliases: Record<string, any[]> = {};
		walk.ancestor(mod, {
			Property(node: any, anc: any[]) {
				const fatherNode = anc[anc.length - 3];
				const fatherFather = anc[anc.length - 4];
				if (
					fatherNode?.type === "AssignmentExpression" &&
					fatherNode?.left?.property?.name === "internalSpec" &&
					fatherNode?.right?.properties.length
				) {
					const values = fatherNode?.right?.properties.map((p: any) => ({
						name: p.key.name,
						id: p.value.value,
					}));
					const nameAlias = fatherNode?.left?.name;
					enumAliases[nameAlias] = values;
				} else if (node?.key?.name && fatherNode.arguments?.length > 0) {
					const values = fatherNode.arguments?.[0]?.properties.map(
						(p: any) => ({
							name: p.key.name,
							id: p.value.value,
						}),
					);
					const nameAlias = fatherFather?.left?.name || fatherFather.id.name;
					enumAliases[nameAlias] = values;
				}
			},
		});
		walk.simple(mod, {
			AssignmentExpression(node: any) {
				if (
					node.left.type === "MemberExpression" &&
					modInfo?.identifiers?.[rename(node.left.property.name)]
				) {
					const ident = modInfo?.identifiers[rename(node.left.property.name)];
					ident.alias = node.right.name;
					ident.enumValues = enumAliases[ident.alias];
				}
			},
		});
	}

	for (const mod of modules) {
		const modInfo = modulesInfo[mod.expression.arguments[0].value];
		const rename = makeRenameFunc();
		const findByAliasInIdentifier = (obj: any, alias: string) => {
			return Object.values(obj).find((item: any) => item.alias === alias);
		};

		walk.simple(mod, {
			AssignmentExpression(node: any) {
				if (
					node.left.type === "MemberExpression" &&
					node.left.property.name === "internalSpec" &&
					node.right.type === "ObjectExpression"
				) {
					const targetIdent = Object.values(modInfo?.identifiers ?? {}).find(
						(v: any) => v.alias === node.left.object.name,
					);
					if (!targetIdent) {
						console.warn(
							`found message specification for unknown identifier alias: ${node.left.object.name}`,
						);
						return;
					}

					const constraints: any[] = [];
					let members: any[] = [];
					for (const p of node.right.properties) {
						p.key.name = p.key.type === "Identifier" ? p.key.name : p.key.value;
						const arr =
							p.key.name.substr(0, 2) === "__" ? constraints : members;
						arr.push(p);
					}

					members = members.map(
						({ key: { name }, value: { elements } }: any) => {
							let type: string | undefined;
							const flags: string[] = [];
							const unwrapBinaryOr = (n: any): any[] =>
								n.type === "BinaryExpression" && n.operator === "|"
									? ([] as any[]).concat(
											unwrapBinaryOr(n.left),
											unwrapBinaryOr(n.right),
										)
									: [n];

							for (const m of unwrapBinaryOr(elements[1]) as Array<{
								type: string;
								object: { type: string; property: { name: string } };
								property: { name: string };
							}>) {
								if (
									m.type === "MemberExpression" &&
									m.object.type === "MemberExpression"
								) {
									if (m.object.property.name === "TYPES") {
										type = m.property.name.toLowerCase();
										if (type === "map") {
											let typeStr = "map<";
											if (elements[2]?.type === "ArrayExpression") {
												const subElements = elements[2].elements;
												subElements.forEach(
													(
														element: {
															property?: { name?: string };
															name?: string;
														},
														index: number,
													) => {
														if (element?.property?.name) {
															typeStr += element?.property?.name?.toLowerCase();
														} else {
															const ref = findByAliasInIdentifier(
																modInfo?.identifiers,
																element?.name || "",
															);
															if (
																ref &&
																typeof ref === "object" &&
																"name" in ref
															) {
																typeStr += (ref as { name: string }).name;
															}
														}
														if (index < subElements.length - 1) {
															typeStr += ", ";
														}
													},
												);
												typeStr += ">";
												type = typeStr;
											}
										}
									} else if (m.object.property.name === "FLAGS") {
										flags.push(m.property.name.toLowerCase());
									}
								}
							}

							if (type === "message" || type === "enum") {
								const currLoc = ` from member '${name}' of message ${targetIdent.name}'`;
								if (elements[2].type === "Identifier") {
									type = Object.values(modInfo?.identifiers ?? {}).find(
										(v: any) => v.alias === elements[2].name,
									)?.name;
									if (!type) {
										console.warn(
											`unable to find reference of alias '${elements[2].name}'${currLoc}`,
										);
									}
								} else if (elements[2].type === "MemberExpression") {
									const crossRef = modInfo?.crossRefs.find(
										(r: any) =>
											r.alias === elements[2]?.object?.name ||
											elements[2]?.object?.left?.name ||
											elements[2]?.object?.callee?.name,
									);
									if (
										elements[1]?.property?.name === "ENUM" &&
										elements[2]?.property?.name?.includes("Type")
									) {
										type = rename(elements[2]?.property?.name);
									} else if (elements[2]?.property?.name.includes("Spec")) {
										type = rename(elements[2].property.name);
									} else if (
										crossRef &&
										crossRef.module !== "$InternalEnum" &&
										modulesInfo[crossRef.module]?.identifiers &&
										modulesInfo[crossRef.module]?.identifiers &&
										modulesInfo[crossRef.module]?.identifiers?.[
											rename(elements[2].property.name)
										]
									) {
										type = rename(elements[2].property.name);
									} else {
										console.warn(
											`unable to find reference of alias to other module '${elements[2].object.name}' or to message ${elements[2].property.name} of this module${currLoc}`,
										);
									}
								}
							}

							return { name, id: elements[0].value, type, flags };
						},
					);

					for (const c of constraints as {
						key: { name: string };
						value: {
							type: string;
							properties: Array<{
								key: { name: string };
								value: { elements: Array<{ value: string }> };
							}>;
						};
					}[]) {
						if (
							c.key.name === "__oneofs__" &&
							c.value.type === "ObjectExpression"
						) {
							const newOneOfs = c.value.properties.map(
								(p: {
									key: { name: string };
									value: { elements: Array<{ value: string }> };
								}) => ({
									name: p.key.name,
									type: "__oneof__",
									members: p.value.elements.map((e: { value: string }) => {
										const idx = members.findIndex(
											(m: { name: string }) => m.name === e.value,
										);
										const member = members[idx];
										members.splice(idx, 1);
										return member;
									}),
								}),
							);
							members.push(...newOneOfs);
						}
					}

					targetIdent.members = members;
				}
			},
		});
	}

	const decodedProtoMap: Record<string, any> = {};
	const spaceIndent = " ".repeat(4);
	for (const mod of modules) {
		const modInfo = modulesInfo[mod.expression.arguments[0].value];
		const identifiers = Object.values(modInfo?.identifiers ?? {});

		const stringifyEnum = (
			ident: any,
			overrideName: string | null = null,
		): string[] =>
			([] as string[]).concat(
				[`enum ${overrideName || ident.displayName || ident.name} {`],
				addPrefix(
					ident.enumValues.map((v: any) => `${v.name} = ${v.id};`),
					spaceIndent,
				),
				["}"],
			);

		const stringifyMessageSpecMember = (
			info: any,
			completeFlags: boolean,
			parentName: string | undefined = undefined,
		): string[] => {
			if (info.type === "__oneof__") {
				return ([] as string[]).concat(
					[`oneof ${info.name} {`],
					addPrefix(
						([] as string[]).concat(
							...info.members.map((m: any) =>
								stringifyMessageSpecMember(m, false),
							),
						),
						spaceIndent,
					),
					["}"],
				);
			}
			if (info.flags.includes("packed")) {
				info.flags.splice(info.flags.indexOf("packed"));
				info.packed = " [packed=true]";
			}
			if (
				completeFlags &&
				info.flags.length === 0 &&
				!info.type.includes("map")
			) {
				info.flags.push("optional");
			}

			const ret: string[] = [];
			const indentation = moduleIndentationMap[info.type]?.indentation;
			let typeName = unnestName(info.type);
			if (indentation !== parentName && indentation) {
				typeName = `${indentation.replaceAll("$", ".")}.${typeName}`;
			}

			ret.push(
				`${
					info.flags.join(" ") + (info.flags.length === 0 ? "" : " ")
				}${typeName} ${info.name} = ${info.id}${info.packed || ""};`,
			);
			return ret;
		};

		const stringifyMessageSpec = (ident: any): string[] => {
			const members = moduleIndentationMap[ident.name]?.members;
			const result: string[] = [];
			result.push(
				`message ${ident.displayName || ident.name} {`,
				...addPrefix(
					[].concat(
						...ident.members.map((m: any) =>
							stringifyMessageSpecMember(m, true, ident.name),
						),
					),
					spaceIndent,
				),
			);

			if (members?.size) {
				const sortedMembers = Array.from(members).sort();
				for (const memberName of sortedMembers) {
					let entity = modInfo?.identifiers?.[memberName];
					if (entity) {
						const displayName = entity.name.slice(ident.name.length + 1);
						entity = { ...entity, displayName };
						result.push(...addPrefix(getEntity(entity), spaceIndent));
					} else {
						console.log("missing nested entity ", memberName);
					}
				}
			}

			result.push("}");
			result.push("");

			return result;
		};

		const getEntity = (v: any): string[] => {
			let result: string[];
			if (v.members) {
				result = stringifyMessageSpec(v);
			} else if (v.enumValues?.length) {
				result = stringifyEnum(v);
			} else {
				result = [`// Unknown entity ${v.name}`];
			}

			return result;
		};

		const stringifyEntity = (v: any) => {
			return {
				content: getEntity(v).join("\n"),
				name: v.name,
			};
		};

		for (const value of identifiers) {
			const { name, content } = stringifyEntity(value);
			if (!moduleIndentationMap[name]?.indentation?.length) {
				decodedProtoMap[name] = content;
			}
		}
	}

	const decodedProto = Object.keys(decodedProtoMap).sort();
	const sortedStr = decodedProto.map((d) => decodedProtoMap[d]).join("\n");

	const decodedProtoStr = `syntax = "proto2";\n\n/// WhatsApp Version: ${whatsAppVersion}\n\n${sortedStr}`;

	return decodedProtoStr;
};

if (import.meta.main) {
	generateProto()
		.then(async (decodedProtoStr) => {
			const destinationPath = "./whatsapp.proto";
			await fs.writeFile(destinationPath, decodedProtoStr);
			console.log(`Extracted protobuf schema to "${destinationPath}"`);
		})
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
