const _ = require("lodash");
const http = require("axios");
const fs = require("fs-extra");
const BbPromise = require("bluebird");
const childProcess = BbPromise.promisifyAll(require("child_process"));
const path = require("path");

const nodeLayerVersionsUrl =
	"https://raw.githubusercontent.com/lumigo-io/lumigo-node/master/layers/LAYERS12x.md";
const pythonLayerVersionsUrl =
	"https://raw.githubusercontent.com/lumigo-io/python_tracer/master/layers/LAYERS37.md";

const NodePackageManagers = {
	NPM: "npm",
	Yarn: "yarn",
	PNPM: "pnpm"
};

const LayerArns = {
	node: null,
	python: null
};

class LumigoPlugin {
	constructor(serverless, options) {
		this.serverless = serverless;
		this.options = options;
		this.log = msg => this.serverless.cli.log(`serverless-lumigo: ${msg}`);
		this.verboseLog = msg => {
			if (process.env.SLS_DEBUG) {
				this.log(msg);
			}
		};
		this.folderPath = path.join(this.serverless.config.servicePath, "_lumigo");

		this.hooks = {
			"after:package:initialize": this.afterPackageInitialize.bind(this),
			"after:deploy:function:initialize": this.afterDeployFunctionInitialize.bind(
				this
			),
			"after:package:createDeploymentArtifacts": this.afterCreateDeploymentArtifacts.bind(
				this
			),
			"after:deploy:function:packageFunction": this.afterDeployFunctionPackageFunction.bind(
				this
			)
		};
		this.extendServerlessSchema();
	}

	extendServerlessSchema() {
		if (
			this.serverless.configSchemaHandler &&
			typeof this.serverless.configSchemaHandler.defineFunctionProperties ===
				"function"
		) {
			this.serverless.configSchemaHandler.defineFunctionProperties("aws", {
				type: "object",
				properties: {
					lumigo: {
						type: "object",
						properties: {
							token: { type: "string" },
							enabled: { type: "boolean" },
							pinVersion: { type: "string" },
							skipInstallNodeTracer: { type: "boolean" },
							skipReqCheck: { type: "boolean" },
							step_function: { type: "boolean" },
							useLayers: { type: "boolean" },
							nodePackageManager: { type: "string" },
							nodeLayerVersion: { type: "string" },
							nodeUseESModule: { type: "boolean" },
							nodeModuleFileExtension: { type: "string" },
							pythonLayerVersion: { type: "string" }
						},
						additionalProperties: false
					}
				}
			});
		}
	}

	get nodeModuleFileExtension() {
		return _.get(
			this.serverless.service,
			"custom.lumigo.nodeModuleFileExtension",
			"js"
		).toLowerCase();
	}

	get nodeUseESModule() {
		return _.get(this.serverless.service, "custom.lumigo.nodeUseESModule", false);
	}

	get nodePackageManager() {
		return _.get(
			this.serverless.service,
			"custom.lumigo.nodePackageManager",
			NodePackageManagers.NPM
		).toLowerCase();
	}

	get useServerlessEsbuild() {
		const plugins = _.get(this.serverless.service, "plugins", []);
		const modulesPlugins = _.get(this.serverless.service, "plugins.modules", []); // backward compatible
		const isServerlessEsbuildInList = list =>
			list.find(plugin => plugin === "serverless-esbuild");
		return (
			(Array.isArray(plugins) && isServerlessEsbuildInList(plugins)) ||
			(Array.isArray(modulesPlugins) && isServerlessEsbuildInList(modulesPlugins))
		);
	}

	get useLayers() {
		return (
			_.get(this.serverless.service, "custom.lumigo.useLayers", false) ||
			this.useServerlessEsbuild
		);
	}

	get pinnedNodeLayerVersion() {
		return _.get(this.serverless.service, "custom.lumigo.nodeLayerVersion", null);
	}

	get pinnedPythonLayerVersion() {
		return _.get(this.serverless.service, "custom.lumigo.pythonLayerVersion", null);
	}

	async afterDeployFunctionInitialize() {
		await this.wrapFunctions([this.options.function]);
	}

	async afterPackageInitialize() {
		await this.wrapFunctions();
	}

	async getLatestNodeLayerVersionArn(layerArn) {
		const resp = await http.get(nodeLayerVersionsUrl);
		const pattern = `${layerArn}:\\d+`;
		const regex = new RegExp(pattern, "gm");
		const matches = regex.exec(resp.data);
		return matches[0];
	}

	async getLatestPythonLayerVersionArn(layerArn) {
		const resp = await http.get(pythonLayerVersionsUrl);
		const pattern = `${layerArn}:\\d+`;
		const regex = new RegExp(pattern, "gm");
		const matches = regex.exec(resp.data);
		return matches[0];
	}

	async getLayerArn(runtime) {
		const region = this.serverless.service.provider.region;
		if (runtime.startsWith("nodejs")) {
			if (this.pinnedNodeLayerVersion) {
				return `arn:aws:lambda:${region}:114300393969:layer:lumigo-node-tracer:${this.pinnedNodeLayerVersion}`;
			} else if (LayerArns.node) {
				return LayerArns.node;
			} else {
				const nodeLayerArn = `arn:aws:lambda:${region}:114300393969:layer:lumigo-node-tracer`;
				LayerArns.node = await this.getLatestNodeLayerVersionArn(nodeLayerArn);
				return LayerArns.node;
			}
		} else if (runtime.startsWith("python")) {
			if (this.pinnedPythonLayerVersion) {
				return `arn:aws:lambda:${region}:114300393969:layer:lumigo-python-tracer:${this.pinnedPythonLayerVersion}`;
			} else if (LayerArns.python) {
				return LayerArns.python;
			} else {
				const pythonLayerArn = `arn:aws:lambda:${region}:114300393969:layer:lumigo-python-tracer`;
				LayerArns.python = await this.getLatestPythonLayerVersionArn(
					pythonLayerArn
				);
				return LayerArns.python;
			}
		}
	}

	async wrapFunctions(functionNames) {
		const { runtime, functions } = this.getFunctionsToWrap(
			this.serverless.service,
			functionNames
		);

		this.log(`there are ${functions.length} function(s) to wrap...`);
		functions.forEach(fn => this.verboseLog(JSON.stringify(fn)));

		if (functions.length === 0) {
			return;
		}

		const token = _.get(this.serverless.service, "custom.lumigo.token");
		if (!token) {
			throw new this.serverless.classes.Error(
				"serverless-lumigo: Unable to find token. Please follow https://github.com/lumigo-io/serverless-lumigo"
			);
		}

		if (!this.useLayers) {
			const pinVersion = _.get(this.serverless.service, "custom.lumigo.pinVersion");
			const skipInstallNodeTracer = _.get(
				this.serverless.service,
				"custom.lumigo.skipInstallNodeTracer",
				false
			);
			let skipReqCheck = _.get(
				this.serverless.service,
				"custom.lumigo.skipReqCheck",
				false
			);

			let parameters = _.get(this.serverless.service, "custom.lumigo", {});
			parameters = _.omit(parameters, [
				"pinVersion",
				"skipReqCheck",
				"skipInstallNodeTracer"
			]);

			if (runtime === "nodejs") {
				if (!skipInstallNodeTracer) {
					await this.installLumigoNodejs(pinVersion);
				}

				for (const func of functions) {
					const handler = await this.createWrappedNodejsFunction(
						func,
						token,
						parameters
					);
					// replace the function handler to the wrapped function
					this.verboseLog(
						`setting [${func.localName}]'s handler to [${handler}]...`
					);
					this.serverless.service.functions[func.localName].handler = handler;
				}
			} else if (runtime === "python") {
				if (skipReqCheck !== true) {
					await this.ensureLumigoPythonIsInstalled();
				} else {
					this.log("Skipping requirements.txt check");
				}

				const { isZip } = await this.getPythonPluginConfiguration();
				this.verboseLog(`Python plugin zip status ${isZip}`);
				for (const func of functions) {
					const handler = await this.createWrappedPythonFunction(
						func,
						token,
						parameters,
						isZip
					);
					// replace the function handler to the wrapped function
					this.verboseLog(
						`setting [${func.localName}]'s handler to [${handler}]...`
					);
					this.serverless.service.functions[func.localName].handler = handler;
				}
			}

			if (this.serverless.service.package) {
				const include = this.serverless.service.package.include || [];
				include.push("_lumigo/*");
				this.serverless.service.package.include = include;
			}
		}
	}

	async updateFunctionConfigAfterPackage(functionNames) {
		const { runtime, functions } = this.getFunctionsToWrap(
			this.serverless.service,
			functionNames
		);
		if (this.useLayers) {
			const token = _.get(this.serverless.service, "custom.lumigo.token");

			for (const func of functions) {
				const funcRuntime = func.runtime || runtime;
				func.layers = func.layers || [
					...(this.serverless.service.provider.layers || [])
				];
				const layer = await this.getLayerArn(funcRuntime);
				func.layers.push(layer);
				func.environment = func.environment || {};
				func.environment["LUMIGO_ORIGINAL_HANDLER"] = func.handler;
				func.environment["LUMIGO_TRACER_TOKEN"] = token;

				if (funcRuntime.startsWith("nodejs")) {
					func.handler = "lumigo-auto-instrument.handler";
				} else if (funcRuntime.startsWith("python")) {
					func.handler = "/opt/python/lumigo_tracer._handler";
				}

				// replace the function handler to the wrapped function
				this.verboseLog(`adding Lumigo tracer layer to [${func.localName}]...`);
				this.serverless.service.functions[func.localName].handler = func.handler;
				this.serverless.service.functions[func.localName].environment =
					func.environment;
				this.serverless.service.functions[func.localName].layers = func.layers;
			}
			return;
		}

		if (functions.length === 0) {
			return;
		}

		await this.cleanFolder();

		if (runtime === "nodejs") {
			const skipInstallNodeTracer = _.get(
				this.serverless.service,
				"custom.lumigo.skipInstallNodeTracer",
				false
			);
			if (!skipInstallNodeTracer) {
				await this.uninstallLumigoNodejs();
			}
		}
	}

	async afterCreateDeploymentArtifacts() {
		await this.updateFunctionConfigAfterPackage();
	}

	async afterDeployFunctionPackageFunction() {
		await this.updateFunctionConfigAfterPackage([this.options.function]);
	}

	getFunctionsToWrap(service, functionNames) {
		functionNames = functionNames || this.serverless.service.getAllFunctions();

		const functions = service
			.getAllFunctions()
			.filter(localName => functionNames.includes(localName))
			.filter(localName => {
				const { lumigo = {} } = this.serverless.service.getFunction(localName);
				return lumigo.enabled == undefined || lumigo.enabled === true;
			})
			.map(localName => {
				const x = _.cloneDeep(service.getFunction(localName));
				x.localName = localName;
				return x;
			});

		if (service.provider.runtime.startsWith("nodejs")) {
			return { runtime: "nodejs", functions };
		} else if (service.provider.runtime.startsWith("python3")) {
			return { runtime: "python", functions };
		} else {
			this.log(`unsupported runtime: [${service.provider.runtime}], skipped...`);
			return { runtime: "unsupported", functions: [] };
		}
	}

	async installLumigoNodejs(pinVersion) {
		const finalVersion = pinVersion || "latest";
		this.log(`installing @lumigo/tracer@${finalVersion}...`);
		let installCommand;
		if (this.nodePackageManager === NodePackageManagers.NPM) {
			installCommand = `npm install @lumigo/tracer@${finalVersion}`;
		} else if (this.nodePackageManager === NodePackageManagers.Yarn) {
			installCommand = `yarn add @lumigo/tracer@${finalVersion}`;
		} else if (this.nodePackageManager === NodePackageManagers.PNPM) {
			installCommand = `pnpm add @lumigo/tracer@${finalVersion}`;
		} else {
			throw new this.serverless.classes.Error(
				"No Node.js package manager found. Please install either NPM, PNPM or Yarn."
			);
		}

		const installDetails = childProcess.execSync(installCommand, "utf8");
		this.verboseLog(installDetails);
	}

	async uninstallLumigoNodejs() {
		this.log("uninstalling @lumigo/tracer...");
		let uninstallCommand;
		if (this.nodePackageManager === NodePackageManagers.NPM) {
			uninstallCommand = "npm uninstall @lumigo/tracer";
		} else if (this.nodePackageManager === NodePackageManagers.Yarn) {
			uninstallCommand = "yarn remove @lumigo/tracer";
		} else if (this.nodePackageManager === NodePackageManagers.PNPM) {
			uninstallCommand = "pnpm remove @lumigo/tracer";
		} else {
			throw new this.serverless.classes.Error(
				"No Node.js package manager found. Please install either NPM, PNPM or Yarn."
			);
		}

		const uninstallDetails = childProcess.execSync(uninstallCommand, "utf8");
		this.verboseLog(uninstallDetails);
	}

	async getPythonPluginConfiguration() {
		const isZip = _.get(
			this.serverless.service,
			"custom.pythonRequirements.zip",
			false
		);

		return { isZip };
	}

	async ensureLumigoPythonIsInstalled() {
		this.log("checking if lumigo_tracer is installed...");

		const pluginsSection = _.get(this.serverless.service, "plugins", []);
		const plugins = Array.isArray(pluginsSection)
			? pluginsSection
			: pluginsSection.modules;
		const slsPythonInstalled = plugins.includes("serverless-python-requirements");

		const ensureTracerInstalled = async fileName => {
			const requirementsExists = fs.pathExistsSync(fileName);

			if (!requirementsExists) {
				let errorMessage = `${fileName} is not found.`;
				if (!slsPythonInstalled) {
					errorMessage += `
Consider using the serverless-python-requirements plugin to help you package Python dependencies.`;
				}
				throw new this.serverless.classes.Error(errorMessage);
			}

			const requirements = await fs.readFile(fileName, "utf8");
			if (
				!requirements.includes("lumigo_tracer") &&
				!requirements.includes("lumigo-tracer")
			) {
				const errorMessage = `lumigo_tracer is not installed. Please check ${fileName}.`;
				throw new this.serverless.classes.Error(errorMessage);
			}
		};

		const packageIndividually = _.get(
			this.serverless.service,
			"package.individually",
			false
		);

		if (packageIndividually) {
			this.log(
				"functions are packed individually, ensuring each function has a requirement.txt..."
			);
			const { functions } = this.getFunctionsToWrap(this.serverless.service);

			for (const fn of functions) {
				// functions/hello.world.handler -> functions
				const dir = path.dirname(fn.handler);

				// there should be a requirements.txt in each function's folder
				// unless there's an override
				const defaultRequirementsFilename = path.join(dir, "requirements.txt");
				const requirementsFilename = _.get(
					this.serverless.service,
					"custom.pythonRequirements.fileName",
					defaultRequirementsFilename
				);
				await ensureTracerInstalled(requirementsFilename);
			}
		} else {
			this.log("ensuring there is a requirement.txt or equivalent...");
			const requirementsFilename = _.get(
				this.serverless.service,
				"custom.pythonRequirements.fileName",
				"requirements.txt"
			);
			await ensureTracerInstalled(requirementsFilename);
		}
	}

	getTracerParameters(
		token,
		options,
		equalityToken = ":",
		trueValue = "true",
		falseValue = "false"
	) {
		if (token === undefined) {
			throw new this.serverless.classes.Error("Lumigo's tracer token is undefined");
		}
		let configuration = [];
		options = _.omit(options, [
			"nodePackageManager",
			"nodeUseESModule",
			"nodeModuleFileExtension"
		]);
		for (const [key, value] of Object.entries(options)) {
			if (String(value).toLowerCase() === "true") {
				configuration.push(`${key}${equalityToken}${trueValue}`);
			} else if (String(value).toLowerCase() === "false") {
				configuration.push(`${key}${equalityToken}${falseValue}`);
			} else {
				configuration.push(`${key}${equalityToken}'${value}'`);
			}
		}
		return configuration.join(",");
	}

	getNodeTracerParameters(token, options) {
		return this.getTracerParameters(token, options, ":", "true", "false");
	}

	getPythonTracerParameters(token, options) {
		return this.getTracerParameters(token, options, "=", "True", "False");
	}

	async createWrappedNodejsFunction(func, token, options) {
		this.verboseLog(`wrapping [${func.handler}]...`);

		const localName = func.localName;

		// e.g. functions/hello.world.handler -> hello.world.handler
		const handler = path.basename(func.handler);

		// e.g. functions/hello.world.handler -> functions/hello.world
		const handlerModulePath = func.handler.substr(0, func.handler.lastIndexOf("."));
		// e.g. functions/hello.world.handler -> handler
		const handlerFuncName = handler.substr(handler.lastIndexOf(".") + 1);

		// too shorten the file extension ref for prettier during test:all
		const fileExt = this.nodeModuleFileExtension;

		const wrappedESMFunction = `
import lumigo from '@lumigo/tracer'
import {${handlerFuncName} as originalHandler} from '../${handlerModulePath}.${fileExt}'
const tracer = lumigo({ ${this.getNodeTracerParameters(token, options)} })

export const ${handlerFuncName} = tracer.trace(originalHandler);`;

		const wrappedCJSFunction = `
const tracer = require("@lumigo/tracer")({
	${this.getNodeTracerParameters(token, options)}
});
const handler = require('../${handlerModulePath}').${handlerFuncName};

module.exports.${handlerFuncName} = tracer.trace(handler);`;

		const wrappedFunction = this.nodeUseESModule
			? wrappedESMFunction
			: wrappedCJSFunction;

		const fileName = localName + ".js";
		// e.g. hello.world.js -> /Users/username/source/project/_lumigo/hello.world.js
		const filePath = path.join(this.folderPath, fileName);
		this.verboseLog(`writing wrapper function to [${filePath}]...`);
		await fs.outputFile(filePath, wrappedFunction);

		// convert from abs path to relative path, e.g.
		// /Users/username/source/project/_lumigo/hello.world.js -> _lumigo/hello.world.js
		// Make sure to support windows paths
		const newFilePath = path
			.relative(this.serverless.config.servicePath, filePath)
			.replace("\\", "/");
		// e.g. _lumigo/hello.world.js -> _lumigo/hello.world.handler
		return newFilePath.substr(0, newFilePath.lastIndexOf(".") + 1) + handlerFuncName;
	}

	async createWrappedPythonFunction(func, token, options, isZip) {
		this.verboseLog(`wrapping [${func.handler}]...`);

		const localName = func.localName;

		// e.g. functions/hello.world.handler -> hello.world.handler
		const handler = path.basename(func.handler);

		// e.g. functions/hello.world.handler -> functions.hello.world
		const handlerModulePath = func.handler
			.substr(0, func.handler.lastIndexOf("."))
			.split("/") // replace all occurances of "/""
			.join(".");
		// e.g. functions/hello.world.handler -> handler
		const handlerFuncName = handler.substr(handler.lastIndexOf(".") + 1);
		let addZipConstruct = "";
		if (isZip) {
			addZipConstruct = `
try:
  import unzip_requirements
except ImportError:
  pass
		`;
		}
		const wrappedFunction = `
${addZipConstruct}
import importlib
from lumigo_tracer import lumigo_tracer
userHandler = getattr(importlib.import_module("${handlerModulePath}"), "${handlerFuncName}")

@lumigo_tracer(${this.getPythonTracerParameters(token, options)})
def ${handlerFuncName}(event, context):
  return userHandler(event, context)
    `;

		const fileName = localName + ".py";
		// e.g. hello.world.py -> /Users/username/source/project/_lumigo/hello.world.py
		const filePath = path.join(this.folderPath, fileName);
		this.verboseLog(`writing wrapper function to [${filePath}]...`);
		await fs.outputFile(filePath, wrappedFunction);

		// convert from abs path to relative path, e.g.
		// /Users/username/source/project/_lumigo/hello.world.py -> _lumigo/hello.world.py
		const newFilePath = path.relative(this.serverless.config.servicePath, filePath);
		// e.g. _lumigo/hello.world.py -> _lumigo/hello.world.handler
		return newFilePath.substr(0, newFilePath.lastIndexOf(".") + 1) + handlerFuncName;
	}

	async cleanFolder() {
		this.verboseLog(`removing the temporary folder [${this.folderPath}]...`);
		return fs.remove(this.folderPath);
	}
}

module.exports = LumigoPlugin;
