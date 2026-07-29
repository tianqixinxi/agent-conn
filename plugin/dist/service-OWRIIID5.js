import { createRequire as __agentCommCr } from "node:module"; const require = __agentCommCr(import.meta.url);
import"./chunk-I6WTBJ3K.js";import{spawnSync}from"node:child_process";import{existsSync,mkdirSync,rmSync,writeFileSync}from"node:fs";import{homedir}from"node:os";import{dirname,join,resolve}from"node:path";function defaultExecutor(input){const result=spawnSync(input.command,input.args,{encoding:"utf8",stdio:["ignore","ignore","pipe"],shell:false});return{status:result.status,stderr:result.stderr}}function xml(value){return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;")}function cliArguments(cliPath){return cliPath.endsWith(".ts")?["--import","tsx",cliPath]:[cliPath]}function renderLaunchdService(input){const argumentsList=[input.nodePath,...cliArguments(input.cliPath),"--profile",input.profile.name,"daemon","run"];const array=argumentsList.map(value=>`      <string>${xml(value)}</string>`).join("\n");return`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>dev.agentcomm.runtime</string>
    <key>ProgramArguments</key>
    <array>
${array}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AGENT_COMM_ROOT</key>
      <string>${xml(input.profile.rootDir)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(join(input.profile.rootDir,"daemon.out.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(input.profile.rootDir,"daemon.err.log"))}</string>
  </dict>
</plist>
`}function systemdQuote(value){return`"${value.replaceAll("\\","\\\\").replaceAll('"','\\"').replaceAll("%","%%")}"`}function renderSystemdService(input){const command=[input.nodePath,...cliArguments(input.cliPath),"--profile",input.profile.name,"daemon","run"].map(systemdQuote).join(" ");return`[Unit]
Description=AgentComm Runtime Supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=${systemdQuote(`AGENT_COMM_ROOT=${input.profile.rootDir}`)}
ExecStart=${command}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`}function installDaemonService(options){const platform=options.platform??process.platform;if(platform!=="darwin"&&platform!=="linux"){throw new Error(`daemon service installation is not supported on ${platform}`)}const cliPath=resolve(process.argv[1]??"");const nodePath=resolve(process.execPath);const home=resolve(homedir());const execute=options.execute??defaultExecutor;const start=options.start??true;let path;let content;if(platform==="darwin"){path=join(home,"Library","LaunchAgents","dev.agentcomm.runtime.plist");content=renderLaunchdService({profile:options.profile,nodePath,cliPath})}else{path=join(home,".config","systemd","user","agentcomm.service");content=renderSystemdService({profile:options.profile,nodePath,cliPath})}mkdirSync(dirname(path),{recursive:true,mode:448});writeFileSync(path,content,{mode:384});if(!start)return{platform,path,started:false};const commands=platform==="darwin"?[{command:"launchctl",args:["bootout",`gui/${process.getuid?.()??0}`,path]},{command:"launchctl",args:["bootstrap",`gui/${process.getuid?.()??0}`,path]}]:[{command:"systemctl",args:["--user","daemon-reload"]},{command:"systemctl",args:["--user","enable","--now","agentcomm.service"]}];for(const command of commands){const result=execute(command);if(platform==="darwin"&&command.args[0]==="bootout")continue;if(result.status!==0){throw new Error(`${command.command} failed: ${result.stderr?.trim()||`exit ${result.status??"unknown"}`}`)}}return{platform,path,started:true}}function uninstallDaemonService(options={}){const platform=options.platform??process.platform;if(platform!=="darwin"&&platform!=="linux"){throw new Error(`daemon service installation is not supported on ${platform}`)}const home=resolve(homedir());const execute=options.execute??defaultExecutor;const path=platform==="darwin"?join(home,"Library","LaunchAgents","dev.agentcomm.runtime.plist"):join(home,".config","systemd","user","agentcomm.service");if(platform==="darwin"){execute({command:"launchctl",args:["bootout",`gui/${process.getuid?.()??0}`,path]})}else{execute({command:"systemctl",args:["--user","disable","--now","agentcomm.service"]});execute({command:"systemctl",args:["--user","daemon-reload"]})}const removed=existsSync(path);rmSync(path,{force:true});return{removed,path}}export{installDaemonService,renderLaunchdService,renderSystemdService,uninstallDaemonService};
