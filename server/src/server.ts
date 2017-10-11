/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, 
	InitializeResult, TextDocumentPositionParams, DidSaveTextDocumentParams,
	DocumentSymbolParams, SymbolInformation, Location, Range
} from 'vscode-languageserver';

var parser  = require('@xxxg0001/luaparse');

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites. 
let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
	workspaceRoot = params.rootPath;
	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind,
			// Tell the client that the server support goto xxx
			documentSymbolProvider:true,
			definitionProvider: true
		}
	}
});

class Identifier {
	name:string;
	base:string;
	range:Range;
}

class LuaFileInfo {
	path:string;
	changed:boolean;
	identifiers:Identifier[];
	symbolList:SymbolInformation[];
	symbolDict:{ [key:string]:SymbolInformation; }

	constructor(path:string) {
		this.path = path;
		this.changed = true;
		this.identifiers = [];
		this.symbolList = [];
		this.symbolDict = {};
	}

	cleanSymbol() {
		this.identifiers = [];
		this.symbolList = [];
		this.symbolDict = {};
	}

	insertSymbol(symbol:SymbolInformation) {
		this.symbolList.push(symbol);
		this.symbolDict[symbol.name] = symbol;
	}
}

let luaFileDict:{[key:string]:LuaFileInfo} = {};

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	let path = uniformPath(change.document.uri);
	let luaFile = luaFileDict[path];
	if (luaFile) {
		luaFile.changed = true;
		return;
	}
});

function uniformPath(uri:string):string {
	let path:string = decodeURIComponent(uri);
	path = path.replace(/\w:/g, (matchedStr) => {
		return matchedStr.toLowerCase();
	});
	path = path.replace(/\\/g, '/');
	return path;
}

function refreshFile(uri:string):void {
	let path = uniformPath(uri);
	let luaFile = luaFileDict[path];
	if (!luaFile) {
		luaFile = new LuaFileInfo(path);
		luaFileDict[path] = luaFile;
	}

	if (luaFile.changed) {
		luaFile.cleanSymbol();
		parseFile(uri);
		connection.console.log(JSON.stringify(luaFile));
	}
}

function parseFile(uri:string):void {
	let path = uniformPath(uri);
	let luaFile = luaFileDict[path];
	let content = documents.get(uri).getText();
	let ast = parser.parse(content, {comments:false, locations:true});
	parseNode(luaFile, [], ast);
	luaFile.changed = false;
}

function getRange(node:any):any {
	return  {
		start:{line:node.loc.start.line - 1, character:node.loc.start.column},
		end:{line:node.loc.end.line - 1, character:node.loc.end.column}
	};
}

function parseNode(luaFile:LuaFileInfo, parents:any[], node:any):void {
	switch (node.type) {
	case "Identifier":
		let identifier = {
			base:"",
			name:node.name,
			range:getRange(node)
		}
		luaFile.identifiers.push(identifier);
		break;
	case "FunctionDeclaration":
		if (node.identifier != null) {
			let name = node.identifier.name;
			let symbol = SymbolInformation.create(name, 12, getRange(node), luaFile.path);
			luaFile.insertSymbol(symbol);
		}
		if (node.body != null) {
			for (var i=0; i < node.body.length; i++) {
				var stack = [node].concat(parents);
				parseNode(luaFile, stack, node.body[i]);	
			}
		}
		break;
	case "CallStatement":
		parseNode(luaFile, parents, node.expression);
		break
	case "CallExpression":
		parseNode(luaFile, parents, node.base);
		if (node.arguments != null) {
			for (var i=0; i < node.arguments.length; i++) {
				parseNode(luaFile, parents, node.arguments[i]);
			}
		}
		break;
	default:
		if (node.identifier != null) {
			parseNode(luaFile, parents, node.identifier);
		}
		if (node.body != null) {
			for (var i=0; i < node.body.length; i++) {
				parseNode(luaFile, parents, node.body[i]);
			}
		}
	}
}

function selectIdent(uri:string, line:number, character:number):Identifier {
	let path = uniformPath(uri);
	let luaFile = luaFileDict[path];
	for (var i=0; i < luaFile.identifiers.length; i++) {
		let identifier = luaFile.identifiers[i];
		if (identifier.range.start.line <= line && line <= identifier.range.end.line)
		{
			if (identifier.range.start.character <= character && character <= identifier.range.end.character)
			{
				return identifier
			}
		}
	}
	return null;
}

function searchIdent(uri:string, identifier:Identifier):Location[] {
	let locations = []
	let path = uniformPath(uri);
	let luaFile = luaFileDict[path];
	let symbol = luaFile.symbolDict[identifier.name];
	if (symbol != null) {
		locations.push(symbol.location);
	}
	return locations;
}

// The settings interface describe the server relevant settings part
interface Settings {
	lspSample: ExampleSettings;
}

// These are the example settings we defined in the client's package.json
// file
interface ExampleSettings {
	luaVersion: number;
}

// hold the luaVersion setting
let luaVersion: number;
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((change) => {
	let settings = <Settings>change.settings;
	luaVersion = settings.lspSample.luaVersion;
});

connection.onDidChangeWatchedFiles((_change) => {
	// Monitored files have change in VSCode
	connection.console.log('We recevied an file change event');
});

connection.onDocumentSymbol((params:DocumentSymbolParams): SymbolInformation[] =>{
	refreshFile(params.textDocument.uri);
	connection.console.log('We recevied an onDocumentSymbol event');
	console.log(JSON.stringify(params));
	let path = uniformPath(params.textDocument.uri);
	let luaFile = luaFileDict[path];
	return luaFile.symbolList;
})

connection.onDefinition((params: TextDocumentPositionParams): Location[] => {
	refreshFile(params.textDocument.uri);
	connection.console.log('We recevied an onDefinition event');
	console.log(JSON.stringify(params));
	let identifier = selectIdent(params.textDocument.uri, params.position.line, params.position.character);
	if (identifier == null) {
		console.log("onDefinition can not find identifier")
		return [];
	}
	return searchIdent(params.textDocument.uri, identifier);
});

connection.onDidSaveTextDocument((params:DidSaveTextDocumentParams) =>{
	refreshFile(params.textDocument.uri);
});

/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Listen on the connection
connection.listen();
