const yaml = require('js-yaml');
const { Octokit } = require("@octokit/rest");
const mail = require('@sendgrid/mail');
mail.setApiKey(process.env.SENDGRID_API_KEY);

module.exports = async function (context, myTimer) {
    const octokit = new Octokit({
        auth: process.env.GITHUB_PAT
    });
    console.log(process.env.GITHUB_PAT.substring(0, 6));
    const { data } = await octokit.search.code({
        q: "Azure/static-web-apps-deploy language:YAML",
        sort: "indexed",
        per_page: 120
    });

    const workflows = data.items;

    const counters = {
        increment(name) {
            if (!this[name]) {
                this[name] = 0;
            }
            this[name]++;
        }
    }

    let prevContentOptions = null;
    for (const workflow of workflows) {
        workflow.info = {
            errors: [],
            runs: []
        };
        try {
            // context.log(workflow.html_url);

            const contentOptions = {
                owner: workflow.repository.owner.login,
                repo: workflow.repository.name,
                path: workflow.path,
                ref: getRef(workflow.url)
            };

            if (prevContentOptions) {
                if (contentOptions.owner === prevContentOptions.owner &&
                    contentOptions.repo === prevContentOptions.repo) {

                    context.log("Skipping duplicate: " + JSON.stringify(contentOptions));
                    workflow.skipped = true;
                    continue;
                }
            }
            prevContentOptions = contentOptions;
            
            const { content: workflowContent } = await getContent(octokit, contentOptions);
            const deployJob = workflowContent.jobs.build_and_deploy_job;
            const deployStep = deployJob.steps.find(s => /^Azure\/static-web-apps-deploy\b/i.test(s.uses));
            
            workflow.info.appLocation = deployStep.with.app_location;
            workflow.info.apiLocation = deployStep.with.api_location;

            if (workflow.info.appLocation) {
                contentOptions.path = workflow.info.appLocation.replace(/^\//, ""); 
                const appFolder = await getContent(octokit, contentOptions);
                
                if (appFolder && Array.isArray(appFolder)) {
                    workflow.info.packageJson = appFolder.find(f => f.name.toLowerCase() === "package.json");
                    workflow.info.csproj = appFolder.find(f => f.name.toLowerCase().endsWith(".csproj"));
                    workflow.info.configToml = appFolder.find(f => f.name.toLowerCase() === "config.toml");
                    workflow.info.configYaml = appFolder.find(f => f.name.toLowerCase() === "config.yaml");
                    workflow.info._configYaml = appFolder.find(f => f.name.toLowerCase() === "_config.yml");
                    
                    workflow.info.framework = await guessFramework(octokit, contentOptions, workflow.info);
                } else {
                    // sometimes there's a build step prior to the action so this might be okay
                    //workflow.info.errors.push(`app_location ${JSON.stringify(contentOptions)} not found`);
                }
            }
            
            if (workflow.info.apiLocation) {
                contentOptions.path = workflow.info.apiLocation.replace(/^\//, ""); 
                const apiFolder = await getContent(octokit, contentOptions);
                
                if (!apiFolder || !Array.isArray(apiFolder)) {
                    // context.log.error("invalid api_location");
                    workflow.info.errors.push(`api_location ${contentOptions.path} not found`);
                    counters.increment("apiLocation.missing");
                } else {
                    const hostJson = apiFolder.find(f => f.name === "host.json");
                    if (!hostJson) {
                        workflow.info.errors.push(`api_location ${contentOptions.path} missing host.json`);
                    }
                    counters.increment("apiLocation.hostJsonMissing");
                }
            }
            
            const { data: workflowRuns } = await octokit.actions.listWorkflowRunsForRepo({
                owner: workflow.repository.owner.login,
                repo: workflow.repository.name,
                per_page: 100
            });

            workflow.info.runs = workflowRuns.workflow_runs.map(r => ({
                status: r.status,
                conclusion: r.conclusion,
                createdAt: r.created_at,
                htmlUrl: r.html_url
            }));

            // context.log(JSON.stringify(workflow.info, null, 2));
        } catch (e) {
            const filename = workflow && workflow.url;
            const msg = `Failed to process ${filename}\n${e.toString()}`;
            // context.log.error(msg);
            workflow.info.errors.push(msg);
        }

        const runEmojis = workflow.info.runs
            .map(r => r.conclusion === "success" ? "✅" : (r.conclusion === "failure" ? "⛔️" : "❔"))
            .join("");
        const errors = workflow.info.errors.join("\n");

        if (workflow.info.runs.length) {
            workflow.info.latestCreatedDate = workflow.info.runs[0].createdAt;
        }
        context.log(`${workflow.html_url}\n${workflow.info.latestCreatedDate} ${runEmojis}\n${workflow.info.framework}\n${errors}\n`);

        counters.increment("framework." + (workflow.info.framework || "undefined"));
        counters.increment("TOTAL");
        counters.increment("latestWorkflowRun." + (workflow.info.runs.length ? workflow.info.runs[0].conclusion : "none"));
    }

    const counterKeys = Object.keys(counters).sort();
    for (const key of counterKeys) {
        if (Number.isInteger(counters[key])) {
            context.log(`${key}: ${counters[key]}`);
        }
    }

    await sendEmail(workflows, counters);
};

function getRef(fileUrl) {
    const match = /\bref=([0-9a-z]+)/.exec(fileUrl);
    return match[1];
}

async function getContent(octokit, contentOptions, isRetry) {
    try {
        const { status, data } = await octokit.repos.getContent(contentOptions);
        
        if (status == 429 && !isRetry) {
            context.log.warning("429 retrying");
            await new Promise(resolve => setTimeout(resolve, 2000));
            return getContent(octokit, contentOptions, true);
        } else if (status !== 200) {
            return;
        }

        if (data.content && data.encoding === "base64") {
            const buffer = Buffer.from(data.content.replace(/\s+/g, ""), "base64");
            data.content = yaml.load(buffer.toString('utf-8'));
        }

        return data;
    } catch {
        return;
    }
}

async function guessFramework(octokit, contentOptions, info) {
    if (info.configToml || info.configYaml) {
        return "hugo";
    }

    if (info._configYaml) {
        return "jekyll";
    }

    if (info.csproj) {
        // TODO: need to check csproj because there are other frameworks like Uno and Statiq
        return "blazor";
    }

    if (!info.packageJson) {
        return "unknown";
    }

    contentOptions.path = info.packageJson.path;
    const packageJson = await getContent(octokit, contentOptions);

    if (!packageJson || !packageJson.content) {
        return "unknown";
    }

    if (packageJson.content.devDependencies) {
        if (Object.keys(packageJson.content.devDependencies).find(p => p === "@11ty/eleventy")) {
            return "11ty";
        }
        if (Object.keys(packageJson.content.devDependencies).find(p => /\bsvelte\b/.test(p))) {
            return "svelte";
        }
    }

    if (packageJson.content.dependencies) {
        if (Object.keys(packageJson.content.dependencies).find(p => p === "vuepress")) {
            return "vuepress";
        }
        if (Object.keys(packageJson.content.dependencies).find(p => p === "gatsby")) {
            return "gatsby";
        }
        if (Object.keys(packageJson.content.dependencies).find(p => p === "contentful")) {
            return "contentful";
        }
        if (Object.keys(packageJson.content.dependencies).find(p => p === "next")) {
            return "next";
        }
        if (Object.keys(packageJson.content.dependencies).find(p => p === "nuxt")) {
            return "nuxt";
        }

        if (Object.keys(packageJson.content.dependencies).find(p => p === "react")) {
            return "react";
        }
        if (Object.keys(packageJson.content.dependencies).find(p => p === "@angular/core")) {
            return "angular";
        }
        if (Object.keys(packageJson.content.dependencies).find(p => p === "vue")) {
            return "vue";
        }
    }

    return "unknown";
}

async function sendEmail(workflows, counters) {
    let emailBody = "";

    const counterKeys = Object.keys(counters).sort();
    for (const key of counterKeys) {
        if (Number.isInteger(counters[key])) {
            emailBody += `${key}: ${counters[key]} (${(100.0 * counters[key] / counters.TOTAL).toFixed(1)}%)<br />`;
        }
    }

    for (const workflow of workflows) {
        if (workflow.skipped) {
            continue;
        }

        const repoNameMatch = /https:\/\/.+?\/(.+?\/.+?)\//.exec(workflow.html_url);
        const repoName = repoNameMatch[1];

        const runEmojis = workflow.info.runs
            .map(r => {
                return `<a href="${r.htmlUrl}" title="${r.createdAt}">` +
                (r.conclusion === "success" ? "✅" : (r.conclusion === "failure" ? "⛔️" : "❔")) +
                `</a>`
            })
            .join("");
        const errors = workflow.info.errors.join("<br />");

        if (workflow.info.runs.length) {
            workflow.info.latestCreatedDate = workflow.info.runs[0].createdAt;
        }

        emailBody += `<hr /><b><a href="${workflow.html_url}">${repoName}</a></b><br />`;
        emailBody += `${workflow.info.latestCreatedDate} - ${workflow.info.framework}<br />${runEmojis}`;
        if (errors) {
            emailBody += `<br /><span style="color: #dd0000">${errors}</span>`;
        }
    }

    const msg = {
        to: 'antchu@microsoft.com',
        from: 'anthony@anthonychu.ca',
        subject: `Static Web Apps - daily GitHub workflows report`,
        html: emailBody
    };

    await mail.send(msg);
}