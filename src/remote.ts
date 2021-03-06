/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import * as crypto from 'crypto';
import * as tdshell from './tdshell';

var isConsole = false;

export interface DeploymentFile {
    path: string;
    // either url or content is present
    url?: string;
    content?: string;
    sourceName?: string;
    kind?: string;
    isUnused?: boolean;
}

export interface DeploymentInstructions {
    meta: any;
    files: DeploymentFile[];
    error?: string;
}

async function sendAsync(path: string, data: any = null)
{
    path = path.replace(/^\/+/, "")
    
    if (!/^https:/.test(target)) {
        return await tdshell.sendEncryptedAsync(target, path, data);
    }
    
    let r = td.createRequest(target + "/" + path);        
    
    r.setHeader("accept-encoding", "gzip");    
    if (data) {
        var buf = new Buffer(JSON.stringify(data), "utf8");
        var gzipped: Buffer = zlib.gzipSync(buf);
        console.log("upload " + buf.length + " bytes, compressed " + gzipped.length)
        r.setMethod("post");
        r.setContentAsBuffer(gzipped);
        r.setContentType("application/json;charset=utf8")
        r.setHeader("content-encoding", "gzip");
    }    

    let res = await r.sendAsync();
    console.log(`${path}: ${res.statusCode() }`)
    return res
}

function buildInstructions(testopt = {}) {
    if (!testopt) throw new Error("bad compiler settings");
    
    var instr: DeploymentInstructions = {
        meta: {},
        files: []
    }

    for (let fn of fs.readdirSync(__dirname)) {
        if (!/\.js$/.test(fn)) continue;
        var text = fs.readFileSync(path.join(__dirname, fn), "utf8");
        instr.files.push({
            path: "script/" + fn,
            content: text
        })
    }
    
        instr.files.push({
            path: "package.json",
            content: fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
        })
        
    instr.files.push({
        path: "script/compiled.js",
        content: "require(\"./tdlite.js\");\n"
    })
    
    return instr;
}

var target:string;

async function deployAsync()
{
    var resp = await sendAsync("/deploy", buildInstructions())
}

function showLogs(msgs: td.LogMessage[], skipcat = "") {
    function levelToClass(level: number) {
        if (level <= td.App.ERROR) return "error";
        else if (level <= td.App.WARNING) return "warning";
        else if (level <= td.App.INFO) return "info";
        else if (level <= td.App.DEBUG) return "debug";
        else return "noisy";
    }

    var res = [];
    msgs.filter(msg => !!msg).forEach((lvl, index) => {
        if (isConsole && index >= 30) {
            if (index == 30) console.log("... use less to see more ...")
            return
        }
        
        var msg = lvl.msg;
        var txt = msg

        if (lvl.meta && lvl.meta.contextId) {
            txt += " [" + lvl.meta.contextId + ": " + Math.round(lvl.meta.contextDuration) + "ms]"
        }

        txt = (lvl.elapsed ? (lvl.elapsed + '> ') : '')
            + (lvl.category && lvl.category != skipcat ? (lvl.category + ': ') : '')
            + txt;

        console.log(txt);
    });
}

async function shellAsync()
{
    var resp = await sendAsync("/combinedlogs");
    showLogs(resp.contentAsJson()["logs"], "shell");    
}

async function statsAsync()
{
    var resp = await sendAsync("/stats");
    console.log(resp.contentAsJson());    
}

async function logAsync()
{
    var resp = await sendAsync("/info/applog");
    for (let w of resp.contentAsJson()["workers"]) {
        console.log("---------", w.worker)
        if (w.body.applog)
            showLogs(w.body.applog);    
    } 
}

async function getconfigCoreAsync()
{
    var resp = await sendAsync("/getconfig");
    var x = {}
    for (let s of resp.contentAsJson()["AppSettings"]) {
        x[s.Name] = s.Value;
    }
    return x    
}

async function workerAsync(args:string[])
{
    let resp = await sendAsync("worker", {
        path: args[0],
        method: args[1] == null ? "GET" : "POST",
        body: args[1]
    })
    console.log(resp.contentAsJson())
}

async function getconfigAsync()
{
    var x = await getconfigCoreAsync();
    console.log(JSON.stringify(x, null, 2))
}

async function setconfigAsync(args: string[]) {
    if (!args[0]) {
        console.log("need JSON filename or VAR=val")
        return
    }

    var m = /^(\w+)=(.*)$/.exec(args[0])
    var js = {}

    if (m) {
        js = await getconfigCoreAsync();
        if (m[2] == "null")
            delete js[m[1]];
        else
            js[m[1]] = m[2];
    } else {
        js = JSON.parse(fs.readFileSync(args[0], "utf8"))
    }
    
    
    var rr = { AppSettings: [] }
    for (let k of Object.keys(js)) {
        rr.AppSettings.push({ Name: k, Value: js[k] })
    }
    await sendAsync("/setconfig", rr);
    await getconfigAsync();
}

async function restartAsync()
{
    await sendAsync("/setconfig", {});    
}

function main() {
    if ((<any>process.stdout).isTTY) {
        isConsole = true;
    }
    target = process.env["TD_UPLOAD_TARGET"];
    if (!target) {
        console.log("need TD_UPLOAD_TARGET=https://somewhere.com/-tdevmgmt-/seCreTc0deheRE")
        return
    }

    var cmds: any = {
        "deploy                deploy JS files": deployAsync,
        "shell                 see shell logs": shellAsync,
        "log                   see application logs": logAsync,
        "stats                 see various shell stats": statsAsync,
        "restart               restart worker (poke the config)": restartAsync,
        "getenv                fetch current environment config": getconfigAsync,
        "setenv file|VAR=val   set current environment config": setconfigAsync,
        "worker PATH [DATA]    forward to one worker": workerAsync,
    }

    for (let n of Object.keys(cmds)) {
        let k = n.replace(/\s.*/, "");
        if (process.argv[2] == k) {
            cmds[n](process.argv.slice(3))
            return
        }
    }


    console.log("usage: node remote.js command")
    console.log("Commands:")
    for (let n of Object.keys(cmds)) {
        console.log(n);
    }
}

main();

