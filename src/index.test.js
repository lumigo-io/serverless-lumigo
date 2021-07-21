const fs = require("fs-extra");
const childProcess = require("child_process");
const Serverless = require("serverless/lib/Serverless");
const AwsProvider = require("serverless/lib/plugins/aws/provider/awsProvider");

jest.mock("fs-extra");
jest.mock("child_process");

const token = "test-token";
const edgeHost = "edge-host";

expect.extend({
	toContainAllStrings(received, ...strings) {
		const pass = strings.every(s => received.includes(s));
		return {
			message: () =>
				`expected ${received} contain the strings [${strings.join(",")}]`,
			pass
		};
	}
});

let serverless;
let lumigo;
let options;

const log = jest.fn();

beforeEach(() => {
	serverless = new Serverless();
	serverless.servicePath = true;
	serverless.service.service = "lumigo-test";
	serverless.service.provider.compiledCloudFormationTemplate = { Resources: {} };
	serverless.setProvider("aws", new AwsProvider(serverless));
	serverless.cli = { log: log };
	serverless.service.provider.region = "us-east-1";
	serverless.service.functions = {
		hello: {
			handler: "hello.world",
			events: []
		},
		"hello.world": {
			handler: "hello.world.handler", // . in the filename
			events: []
		},
		foo: {
			handler: "foo_bar.handler", // both pointing to same handler
			events: []
		},
		bar: {
			handler: "foo_bar.handler", // both pointing to same handler
			events: []
		},
		jet: {
			handler: "foo/foo/bar.handler", // / in the path
			events: []
		},
		pack: {
			handler: "foo.bar/zoo.handler", // . in file name and / in the path
			events: []
		},
		skippy: {
			handler: "will.skip",
			lumigo: {
				enabled: false
			}
		}
	};
	serverless.service.custom = {
		lumigo: {
			token: token
		}
	};
	serverless.config.servicePath = __dirname;
	childProcess.execSync.mockImplementation(() => "");
	const LumigoPlugin = require("./index");
	options = {};
	lumigo = new LumigoPlugin(serverless, options);

	delete process.env.SLS_DEBUG;
});

afterEach(() => jest.resetAllMocks());

describe("Invalid plugin configuration", () => {
	beforeEach(() => {
		serverless.service.provider.runtime = "nodejs8.10";
	});

	test("Token is not present, exception is thrown", async () => {
		delete serverless.service.custom.lumigo["token"];
		// https://github.com/facebook/jest/issues/1700
		let error;
		try {
			await lumigo.afterPackageInitialize();
		} catch (e) {
			error = e;
		}
		expect(error).toBeTruthy();
	});
});

describe("Lumigo plugin (node.js)", () => {
	describe.each([["nodejs12.x"], ["nodejs10.x"]])("when using runtime %s", runtime => {
		beforeEach(() => {
			serverless.service.provider.runtime = runtime;
		});

		test("edgeHost configuration present, should appear in the wrapped code", async () => {
			serverless.service.custom.lumigo["edgeHost"] = edgeHost;
			await lumigo.afterPackageInitialize();

			expect(fs.outputFile).toBeCalledWith(
				__dirname + "/_lumigo/hello.js",
				expect.toContainAllStrings(`edgeHost:'${edgeHost}'`)
			);
		});

		test("edgeHost configuration not present, should not appear in the wrapped code", async () => {
			await lumigo.afterPackageInitialize();

			expect(fs.outputFile).toBeCalledWith(
				__dirname + "/_lumigo/hello.js",
				expect.not.toContainAllStrings(`edgeHost:'${edgeHost}'`)
			);
		});

		test("it should wrap all non-skipped functions after package initialize", async () => {
			await lumigo.afterPackageInitialize();
			assertNodejsFunctionsAreWrapped();
		});

		test("it should clean up after deployment artifact is created", async () => {
			await lumigo.afterCreateDeploymentArtifacts();
			assertNodejsFunctionsAreCleanedUp();
		});

		describe("there are no functions", () => {
			beforeEach(() => {
				serverless.service.functions = {};
			});

			test("it shouldn't wrap any function after package initialize", async () => {
				await lumigo.afterPackageInitialize();
				assertFunctionsAreNotWrapped();
			});

			test("it does nothing after deployment artifact is created", async () => {
				await lumigo.afterCreateDeploymentArtifacts();
				assertNothingHappens();
			});
		});

		describe("when functions are packaged individually", () => {
			beforeEach(() => {
				serverless.service.package = {
					individually: true
				};
			});

			test("if package.include is not set, it's initialized with _lumigo/*", async () => {
				await lumigo.afterPackageInitialize();
				assertLumigoIsIncluded();
			});

			test("if package.include is set, it adds _lumigo/* to the array", async () => {
				Object.values(serverless.service.functions).forEach(fun => {
					fun.package = {
						include: ["node_modules/**/*"]
					};
				});

				await lumigo.afterPackageInitialize();
				assertLumigoIsIncluded();
			});
		});

		describe("if verbose logging is enabled", () => {
			beforeEach(() => {
				process.env.SLS_DEBUG = "*";
			});

			test("it should publish debug messages", async () => {
				await lumigo.afterPackageInitialize();

				const logs = log.mock.calls.map(x => x[0]);
				expect(logs).toContain(
					"serverless-lumigo: setting [hello]'s handler to [_lumigo/hello.world]..."
				);
			});
		});

		describe("when nodePackageManager is Yarn", () => {
			beforeEach(() => {
				serverless.service.custom.lumigo.nodePackageManager = "yarn";
			});

			test("it should install with Yarn", async () => {
				await lumigo.afterPackageInitialize();

				expect(childProcess.execSync).toBeCalledWith(
					"yarn add @lumigo/tracer@latest",
					"utf8"
				);
			});

			test("it should uninstall with Yarn", async () => {
				await lumigo.afterCreateDeploymentArtifacts();

				expect(childProcess.execSync).toBeCalledWith(
					"yarn remove @lumigo/tracer",
					"utf8"
				);
			});

			test("Pin version", async () => {
				serverless.service.custom.lumigo.pinVersion = "1.0.3";
				await lumigo.afterPackageInitialize();

				expect(childProcess.execSync).toBeCalledWith(
					"yarn add @lumigo/tracer@1.0.3",
					"utf8"
				);
			});
		});

		describe("when nodePackageManager is NPM", () => {
			beforeEach(() => {
				serverless.service.custom.lumigo.nodePackageManager = "npm";
			});

			test("Pin version", async () => {
				serverless.service.custom.lumigo.pinVersion = "1.0.3";
				await lumigo.afterPackageInitialize();

				expect(childProcess.execSync).toBeCalledWith(
					"npm install @lumigo/tracer@1.0.3",
					"utf8"
				);
			});
		});

		describe("when nodePackageManager is not NPM or Yarn", () => {
			beforeEach(() => {
				serverless.service.custom.lumigo.nodePackageManager = "whatever";
			});

			test("it should error on install", async () => {
				await expect(lumigo.afterPackageInitialize()).rejects.toThrow(
					"No Node.js package manager found. Please install either NPM or Yarn."
				);
			});

			test("it should error on uninstall", async () => {
				await expect(lumigo.afterCreateDeploymentArtifacts()).rejects.toThrow(
					"No Node.js package manager found. Please install either NPM or Yarn."
				);
			});
		});

		describe("when deploying a single function using 'sls deploy -f'", () => {
			beforeEach(async () => {
				options.function = "hello";
				await lumigo.afterDeployFunctionInitialize();
			});

			it("should only wrap one function", () => {
				expect(fs.outputFile).toBeCalledTimes(1);
				assertFileOutput({
					filename: "hello.js",
					requireHandler: "require('../hello').world"
				});
				expect(serverless.service.functions.hello.handler).toBe(
					"_lumigo/hello.world"
				);
			});
		});

		describe("when skipInstallNodeTracer is true", () => {
			beforeEach(() => {
				serverless.service.custom.lumigo.skipInstallNodeTracer = true;
			});

			test("it should not install Node tracer", async () => {
				await lumigo.afterPackageInitialize();

				expect(childProcess.execSync).not.toBeCalledWith(
					"npm install @lumigo/tracer@latest",
					"utf8"
				);
			});

			test("it should not uninstall Node tracer", async () => {
				await lumigo.afterCreateDeploymentArtifacts();

				expect(childProcess.execSync).not.toBeCalledWith(
					"npm uninstall @lumigo/tracer",
					"utf8"
				);
			});
		});

		describe("when useLayers is true", () => {
			beforeEach(() => {
				serverless.service.custom.lumigo.useLayers = true;
			});

			test("functions are not wrapped during after:package:initialize", async () => {
				await lumigo.afterPackageInitialize();

				expect(childProcess.execSync).not.toBeCalledWith(
					"npm install @lumigo/tracer",
					"utf8"
				);
			});

			test("functions are not wrapped during after:deploy:function:initialize", async () => {
				await lumigo.afterDeployFunctionInitialize();

				expect(childProcess.execSync).not.toBeCalledWith(
					"npm install @lumigo/tracer",
					"utf8"
				);
			});

			test("layers are added during after:package:initialize", async () => {
				await lumigo.afterPackageInitialize();

				assertNodejsFunctionsHaveLayers();
			});

			test("layers are added during after:deploy:function:initialize", async () => {
				options.function = "hello";
				await lumigo.afterDeployFunctionInitialize();

				const functions = serverless.service.functions;
				expect(functions.hello.handler).toBe("lumigo-auto-instrument.handler");
				expect(functions.hello.layers).toHaveLength(1);
				expect(functions.hello.layers[0]).toEqual(
					expect.stringMatching(
						/arn:aws:lambda:us-east-1:114300393969:layer:lumigo-node-tracer:\d*/
					)
				);
				expect(functions.hello.environment).toHaveProperty(
					"LUMIGO_ORIGINAL_HANDLER"
				);
			});

			describe("if pinned to version 87 of layer", () => {
				beforeEach(() => {
					serverless.service.custom.lumigo.nodeLayerVersion = 87;
				});

				test("layer version 87 are added during after:package:initialize", async () => {
					await lumigo.afterPackageInitialize();

					assertNodejsFunctionsHaveLayers(87);
				});

				test("layers are added during after:deploy:function:initialize", async () => {
					options.function = "hello";
					await lumigo.afterDeployFunctionInitialize();

					const functions = serverless.service.functions;
					expect(functions.hello.handler).toBe(
						"lumigo-auto-instrument.handler"
					);
					expect(functions.hello.layers).toHaveLength(1);
					expect(functions.hello.layers[0]).toEqual(
						"arn:aws:lambda:us-east-1:114300393969:layer:lumigo-node-tracer:87"
					);
					expect(functions.hello.environment).toHaveProperty(
						"LUMIGO_ORIGINAL_HANDLER"
					);
				});
			});
		});
	});
});

describe("Lumigo plugin (python)", () => {
	describe("python2.7", () => {
		beforeEach(() => {
			serverless.service.provider.runtime = "python2.7";
		});

		test("it shouldn't wrap any function after package initialize", async () => {
			await lumigo.afterPackageInitialize();
			assertFunctionsAreNotWrapped();
		});

		test("it does nothing after deployment artifact is created", async () => {
			await lumigo.afterCreateDeploymentArtifacts();
			assertNothingHappens();
		});
	});

	describe("python3.7", () => {
		beforeEach(() => {
			serverless.service.provider.runtime = "python3.7";
		});

		describe("when useLayers is true", () => {
			beforeEach(() => {
				serverless.service.custom.lumigo.useLayers = true;
			});

			afterEach(() => {
				delete serverless.service.custom.lumigo.useLayers;
			});

			test("layers are added during after:package:initialize", async () => {
				await lumigo.afterPackageInitialize();

				assertPythonFunctionsHaveLayers();
			});

			test("layers are added during after:deploy:function:initialize", async () => {
				options.function = "hello";
				await lumigo.afterDeployFunctionInitialize();

				const functions = serverless.service.functions;
				expect(functions.hello.handler).toBe(
					"/opt/python/lumigo_tracer._handler"
				);
				expect(functions.hello.layers).toHaveLength(1);
				expect(functions.hello.layers[0]).toEqual(
					expect.stringMatching(
						/arn:aws:lambda:us-east-1:114300393969:layer:lumigo-python-tracer:\d+/
					)
				);
				expect(functions.hello.environment).toHaveProperty(
					"LUMIGO_ORIGINAL_HANDLER"
				);
			});

			describe("if pinned to version 87 of layer", () => {
				beforeEach(() => {
					serverless.service.custom.lumigo.pythonLayerVersion = 87;
				});

				test("layer version 87 are added during after:package:initialize", async () => {
					await lumigo.afterPackageInitialize();

					assertPythonFunctionsHaveLayers(87);
				});

				test("layers are added during after:deploy:function:initialize", async () => {
					options.function = "hello";
					await lumigo.afterDeployFunctionInitialize();

					const functions = serverless.service.functions;
					expect(functions.hello.handler).toBe(
						"/opt/python/lumigo_tracer._handler"
					);
					expect(functions.hello.layers).toHaveLength(1);
					expect(functions.hello.layers[0]).toEqual(
						"arn:aws:lambda:us-east-1:114300393969:layer:lumigo-python-tracer:87"
					);
					expect(functions.hello.environment).toHaveProperty(
						"LUMIGO_ORIGINAL_HANDLER"
					);
				});
			});
		});

		describe("Using zip configuration", () => {
			beforeEach(() => {
				serverless.service.functions = {
					hello: {
						handler: "hello.world",
						events: []
					}
				};
				serverless.service.custom.pythonRequirements = { zip: true };
				fs.pathExistsSync.mockReturnValue(true);
				fs.readFile.mockReturnValue(`
--index-url https://1wmWND-GD5RPAwKgsdvb6DphXCj0vPLs@pypi.fury.io/lumigo/
--extra-index-url https://pypi.org/simple/
lumigo_tracer`);
			});

			test("When zip is set then add special construct", async () => {
				await lumigo.afterPackageInitialize();
				expect(fs.outputFile).toBeCalledWith(
					__dirname + "/_lumigo/hello.py",
					expect.toContainAllStrings(
						"try:",
						"import unzip_requirements",
						"except ImportError:",
						"pass",
						"from lumigo_tracer import lumigo_tracer",
						getPythonImportLine("hello", "world")
					)
				);
			});
		});

		describe("there are no functions", () => {
			beforeEach(() => {
				serverless.service.functions = {};
			});

			test("it shouldn't wrap any function after package initialize", async () => {
				await lumigo.afterPackageInitialize();
				assertFunctionsAreNotWrapped();
			});

			test("it does nothing after deployment artifact is created", async () => {
				await lumigo.afterCreateDeploymentArtifacts();
				assertNothingHappens();
			});
		});

		describe("given the requirement.txt file exists", () => {
			beforeEach(() => {
				serverless.service.plugins = ["a-module"];
				fs.pathExistsSync.mockReturnValue(true);
				fs.readFile.mockReturnValue(`
--index-url https://1wmWND-GD5RPAwKgsdvb6DphXCj0vPLs@pypi.fury.io/lumigo/
--extra-index-url https://pypi.org/simple/
lumigo_tracer`);
			});

			test("it should wrap all functions after package initialize", async () => {
				await lumigo.afterPackageInitialize();
				assertPythonFunctionsAreWrapped({ token: `'${token}'` });
			});

			test("it should wrap all functions after package initialize with modules in plugins", async () => {
				serverless.service.plugins = { modules: ["a-module"] };
				await lumigo.afterPackageInitialize();
				assertPythonFunctionsAreWrapped({ token: `'${token}'` });
			});

			test("enhance_print configuration present with true, should appear in the wrapped code", async () => {
				serverless.service.custom.lumigo["enhance_print"] = true;
				await lumigo.afterPackageInitialize();

				assertPythonFunctionsAreWrapped({
					token: `'${token}'`,
					enhance_print: "True"
				});
			});

			test("enhance_print configuration present with false, should appear in the wrapped code", async () => {
				serverless.service.custom.lumigo["enhance_print"] = "false";
				await lumigo.afterPackageInitialize();

				assertPythonFunctionsAreWrapped({
					token: `'${token}'`,
					enhance_print: "False"
				});
			});
		});

		test("it should clean up after deployment artifact is created", async () => {
			await lumigo.afterCreateDeploymentArtifacts();
			assertPythonFunctionsAreCleanedUp({ token: `'${token}'` });
		});

		describe("if there is override file name for requirements.txt (for the serverless-python-requirements plugin)", () => {
			beforeEach(() => {
				serverless.service.custom.pythonRequirements = {
					fileName: "requirements-dev.txt"
				};
			});

			test("it should check the requirements for the override file", async () => {
				fs.pathExistsSync.mockReturnValue(true);
				fs.readFile.mockReturnValue(`
  --index-url https://1wmWND-GD5RPAwKgsdvb6DphXCj0vPLs@pypi.fury.io/lumigo/
  --extra-index-url https://pypi.org/simple/
  lumigo_tracer`);

				await lumigo.afterPackageInitialize();
				assertPythonFunctionsAreWrapped({ token: `'${token}'` });
				expect(fs.pathExistsSync).toBeCalledWith("requirements-dev.txt");
				expect(fs.readFile).toBeCalledWith("requirements-dev.txt", "utf8");
			});
		});

		describe("if the requirements.txt is missing", () => {
			beforeEach(() => {
				fs.pathExistsSync.mockReturnValue(false);
			});

			test("it should error", async () => {
				await expect(lumigo.afterPackageInitialize()).rejects;
				expect(fs.pathExistsSync).toBeCalledWith("requirements.txt");
			});
		});

		describe("if the requirements.txt does not have lumigo_tracer", () => {
			beforeEach(() => {
				fs.pathExistsSync.mockReturnValue(true);
				fs.readFile.mockReturnValue("some_other_package");
			});

			test("it should error", async () => {
				await expect(lumigo.afterPackageInitialize()).rejects;
				expect(fs.pathExistsSync).toBeCalledWith("requirements.txt");
				expect(fs.readFile).toBeCalledWith("requirements.txt", "utf8");
			});
		});

		describe("if functions are packed individually", () => {
			beforeEach(() => {
				serverless.service.package = {
					individually: true
				};
				serverless.service.functions = {
					hello: {
						handler: "functions/hello/hello.world",
						events: []
					},
					world: {
						handler: "functions/world/world.handler",
						events: []
					}
				};

				fs.pathExistsSync.mockReturnValue(true);
				fs.readFile.mockReturnValue(`
  --index-url https://1wmWND-GD5RPAwKgsdvb6DphXCj0vPLs@pypi.fury.io/lumigo/
  --extra-index-url https://pypi.org/simple/
  lumigo_tracer`);
			});

			test("it should check the requirements.txt in each function's folder", async () => {
				await lumigo.afterPackageInitialize();
				expect(fs.pathExistsSync).toBeCalledTimes(2);
				expect(fs.pathExistsSync).toBeCalledWith(
					"functions/hello/requirements.txt"
				);
				expect(fs.pathExistsSync).toBeCalledWith(
					"functions/world/requirements.txt"
				);
				expect(fs.readFile).toBeCalledTimes(2);
				expect(fs.readFile).toBeCalledWith(
					"functions/hello/requirements.txt",
					"utf8"
				);
				expect(fs.readFile).toBeCalledWith(
					"functions/world/requirements.txt",
					"utf8"
				);
			});

			describe("if there is override file name for requirements.txt", () => {
				beforeEach(() => {
					serverless.service.custom.pythonRequirements = {
						fileName: "requirements-dev.txt"
					};
				});

				test("it should check the requirements for the override file", async () => {
					await lumigo.afterPackageInitialize();

					expect(fs.pathExistsSync).toBeCalledTimes(2);
					expect(fs.pathExistsSync).toBeCalledWith("requirements-dev.txt");
					expect(fs.readFile).toBeCalledWith("requirements-dev.txt", "utf8");

					expect(fs.pathExistsSync).not.toBeCalledWith(
						"functions/hello/requirements.txt"
					);
					expect(fs.pathExistsSync).not.toBeCalledWith(
						"functions/world/requirements.txt"
					);

					expect(fs.readFile).not.toBeCalledWith(
						"functions/hello/requirements.txt",
						"utf8"
					);
					expect(fs.readFile).not.toBeCalledWith(
						"functions/world/requirements.txt",
						"utf8"
					);
				});
			});

			test("if package.include is not set, it's initialized with _lumigo/*", async () => {
				await lumigo.afterPackageInitialize();
				assertLumigoIsIncluded();
			});

			test("if package.include is set, it adds _lumigo/* to the array", async () => {
				Object.values(serverless.service.functions).forEach(fun => {
					fun.package = {
						include: ["functions/**/*"]
					};
				});

				await lumigo.afterPackageInitialize();
				assertLumigoIsIncluded();
			});
		});

		describe("if verbose logging is enabled", () => {
			beforeEach(() => {
				process.env.SLS_DEBUG = "*";
			});

			test("it should publish debug messages", async () => {
				fs.pathExistsSync.mockReturnValue(true);
				fs.readFile.mockReturnValue(`
  --index-url https://1wmWND-GD5RPAwKgsdvb6DphXCj0vPLs@pypi.fury.io/lumigo/
  --extra-index-url https://pypi.org/simple/
  lumigo_tracer`);

				await lumigo.afterPackageInitialize();

				const logs = log.mock.calls.map(x => x[0]);
				expect(logs).toContain(
					"serverless-lumigo: setting [hello]'s handler to [_lumigo/hello.world]..."
				);
			});
		});
	});
});

describe("is not nodejs or python", () => {
	beforeEach(() => {
		serverless.service.provider.runtime = "java8";
	});

	test("it shouldn't wrap any function after package initialize", async () => {
		await lumigo.afterPackageInitialize();
		assertFunctionsAreNotWrapped();
	});

	test("it does nothing after deployment artifact is created", async () => {
		await lumigo.afterCreateDeploymentArtifacts();
		assertNothingHappens();
	});
});

function assertFileOutput({ filename, requireHandler }) {
	expect(fs.outputFile).toBeCalledWith(
		`${__dirname}/_lumigo/${filename}`,
		expect.toContainAllStrings(
			'const tracer = require("@lumigo/tracer")',
			`const handler = ${requireHandler}`,
			`token:'${token}'`
		)
	);
}

function assertTracerInstall() {
	expect(childProcess.execSync).toBeCalledWith(
		"npm install @lumigo/tracer@latest",
		"utf8"
	);
}

function assertNodejsFunctionsHaveLayers(version) {
	const functions = serverless.service.functions;
	const wrappedFunctions = [
		functions.hello,
		functions["hello.world"],
		functions.foo,
		functions.bar,
		functions.jet,
		functions.pack
	];
	const skippedFunctions = [functions.skippy];

	wrappedFunctions.forEach(func => {
		expect(func.handler).toBe("lumigo-auto-instrument.handler");
		expect(func.layers).toHaveLength(1);
		if (version) {
			expect(func.layers[0]).toEqual(
				`arn:aws:lambda:us-east-1:114300393969:layer:lumigo-node-tracer:${version}`
			);
		} else {
			expect(func.layers[0]).toEqual(
				expect.stringMatching(
					/arn:aws:lambda:us-east-1:114300393969:layer:lumigo-node-tracer:\d+/
				)
			);
		}
		expect(func.environment).toHaveProperty("LUMIGO_ORIGINAL_HANDLER");
	});

	skippedFunctions.forEach(func => {
		expect(func.handler).not.toBe("lumigo-auto-instrument.handler");
		expect(func.layers).toBeUndefined();
		expect(func.environment).toBeUndefined();
	});
}

function assertNodejsFunctionsAreWrapped() {
	assertTracerInstall();

	expect(fs.outputFile).toBeCalledTimes(6);
	[
		{ filename: "hello.js", requireHandler: "require('../hello').world" },
		{
			filename: "hello.world.js",
			requireHandler: "require('../hello.world').handler"
		},
		{ filename: "foo.js", requireHandler: "require('../foo_bar').handler" },
		{ filename: "bar.js", requireHandler: "require('../foo_bar').handler" },
		{ filename: "jet.js", requireHandler: "require('../foo/foo/bar').handler" },
		{ filename: "pack.js", requireHandler: "require('../foo.bar/zoo').handler" }
	].forEach(assertFileOutput);

	const functions = serverless.service.functions;
	expect(functions.hello.handler).toBe("_lumigo/hello.world");
	expect(functions["hello.world"].handler).toBe("_lumigo/hello.world.handler");
	expect(functions.foo.handler).toBe("_lumigo/foo.handler");
	expect(functions.bar.handler).toBe("_lumigo/bar.handler");
	expect(functions.jet.handler).toBe("_lumigo/jet.handler");
	expect(functions.pack.handler).toBe("_lumigo/pack.handler");
}

function assertPythonFunctionsHaveLayers(version) {
	const functions = serverless.service.functions;
	const wrappedFunctions = [
		functions.hello,
		functions["hello.world"],
		functions.foo,
		functions.bar,
		functions.jet,
		functions.pack
	];
	const skippedFunctions = [functions.skippy];

	wrappedFunctions.forEach(func => {
		expect(func.handler).toBe("/opt/python/lumigo_tracer._handler");
		expect(func.layers).toHaveLength(1);
		if (version) {
			expect(func.layers[0]).toEqual(
				`arn:aws:lambda:us-east-1:114300393969:layer:lumigo-python-tracer:${version}`
			);
		} else {
			expect(func.layers[0]).toEqual(
				expect.stringMatching(
					/arn:aws:lambda:us-east-1:114300393969:layer:lumigo-python-tracer:\d*/
				)
			);
		}
		expect(func.environment).toHaveProperty("LUMIGO_ORIGINAL_HANDLER");
	});

	skippedFunctions.forEach(func => {
		expect(func.handler).not.toBe("/opt/python/lumigo_tracer._handler");
		expect(func.layers).toBeUndefined();
		expect(func.environment).toBeUndefined();
	});
}

function getPythonImportLine(handlerModulePath, handlerFuncName) {
	return `userHandler = getattr(importlib.import_module("${handlerModulePath}"), "${handlerFuncName}")`;
}

function assertPythonFunctionsAreWrapped(parameters) {
	let endParams = [];
	for (const [key, value] of Object.entries(parameters)) {
		endParams.push(`${key}=${value}`);
	}
	expect(fs.outputFile).toBeCalledTimes(6);
	expect(fs.outputFile).toBeCalledWith(
		__dirname + "/_lumigo/hello.py",
		expect.toContainAllStrings(
			"from lumigo_tracer import lumigo_tracer",
			getPythonImportLine("hello", "world"),
			`@lumigo_tracer(${endParams.join(",")})`
		)
	);
	expect(fs.outputFile).toBeCalledWith(
		__dirname + "/_lumigo/hello.world.py",
		expect.toContainAllStrings(
			"from lumigo_tracer import lumigo_tracer",
			getPythonImportLine("hello.world", "handler"),
			`@lumigo_tracer(${endParams.join(",")})`
		)
	);
	expect(fs.outputFile).toBeCalledWith(
		__dirname + "/_lumigo/foo.py",
		expect.toContainAllStrings(
			"from lumigo_tracer import lumigo_tracer",
			getPythonImportLine("foo_bar", "handler"),
			`@lumigo_tracer(${endParams.join(",")})`
		)
	);
	expect(fs.outputFile).toBeCalledWith(
		__dirname + "/_lumigo/bar.py",
		expect.toContainAllStrings(
			"from lumigo_tracer import lumigo_tracer",
			getPythonImportLine("foo_bar", "handler"),
			`@lumigo_tracer(${endParams.join(",")})`
		)
	);
	expect(fs.outputFile).toBeCalledWith(
		__dirname + "/_lumigo/jet.py",
		expect.toContainAllStrings(
			"from lumigo_tracer import lumigo_tracer",
			getPythonImportLine("foo.foo.bar", "handler"),
			`@lumigo_tracer(${endParams.join(",")})`
		)
	);
	expect(fs.outputFile).toBeCalledWith(
		__dirname + "/_lumigo/pack.py",
		expect.toContainAllStrings(
			"from lumigo_tracer import lumigo_tracer",
			getPythonImportLine("foo.bar.zoo", "handler"),
			`@lumigo_tracer(${endParams.join(",")})`
		)
	);

	const functions = serverless.service.functions;
	expect(functions.hello.handler).toBe("_lumigo/hello.world");
	expect(functions["hello.world"].handler).toBe("_lumigo/hello.world.handler");
	expect(functions.foo.handler).toBe("_lumigo/foo.handler");
	expect(functions.bar.handler).toBe("_lumigo/bar.handler");
	expect(functions.jet.handler).toBe("_lumigo/jet.handler");
	expect(functions.pack.handler).toBe("_lumigo/pack.handler");
}

function assertFunctionsAreNotWrapped() {
	expect(childProcess.exec).not.toBeCalled();
	expect(fs.outputFile).not.toBeCalled();
}

function assertNodejsFunctionsAreCleanedUp() {
	expect(fs.remove).toBeCalledWith(__dirname + "/_lumigo");
	expect(childProcess.execSync).toBeCalledWith("npm uninstall @lumigo/tracer", "utf8");
}

function assertPythonFunctionsAreCleanedUp() {
	expect(fs.remove).toBeCalledWith(__dirname + "/_lumigo");
}

function assertNothingHappens() {
	expect(fs.remove).not.toBeCalled();
	expect(childProcess.exec).not.toBeCalled();
}

function assertLumigoIsIncluded() {
	expect(serverless.service.package.include).toContain("_lumigo/*");
}
