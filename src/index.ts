import * as core from '@actions/core'
import * as fs from 'fs';
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
    buildSecretsList,
    isSecretArn,
    getSecretValue,
    injectSecret,
    extractAliasAndSecretIdFromInput,
    SecretValueResponse,
    validateOverwriteMode
} from "./utils";
import { CLEANUP_NAME } from "./constants";

export async function run(): Promise<void> {
    try {
        // Default client region is set by configure-aws-credentials
        const client: SecretsManagerClient = new SecretsManagerClient({ region: process.env.AWS_DEFAULT_REGION, customUserAgent: "github-action" });
        const secretConfigInputs: string[] = [...new Set(core.getMultilineInput('secret-ids'))];
        const overwriteMode = validateOverwriteMode(core.getInput('overwrite-mode'));
        const parseJsonSecrets = core.getBooleanInput('parse-json-secrets');
        const publicEnvVars = [...new Set(core.getMultilineInput('public-env-vars'))];
        const publicNumerics = core.getBooleanInput('public-numerics');
        const publicValues = [...new Set(core.getMultilineInput('public-values'))];
        const outputFile = core.getInput('output-file');

        // Get final list of secrets to request
        core.info('Building secrets list...');
        const secretIds: string[] = await buildSecretsList(client, secretConfigInputs);

        // Keep track of secret names that will need to be cleaned from the environment
        let secretsToCleanup = [] as string[];

        core.info('Your secret names may be transformed in order to be valid environment variables (see README). Enable Debug logging in order to view the new environment names.');

        // Clear existing file
        if (outputFile && fs.existsSync(outputFile)) {
            fs.truncateSync(outputFile, 0);
        }

        // Get and inject secret values
        for (let secretId of secretIds) {
            //  Optionally let user set an alias, i.e. `ENV_NAME,secret_name`
            let secretAlias: string | undefined = '';
            [secretAlias, secretId] = extractAliasAndSecretIdFromInput(secretId);

            // Retrieves the secret name also, if the value is an ARN
            const isArn = isSecretArn(secretId);

            try {
                const secretValueResponse: SecretValueResponse = await getSecretValue(client, secretId);
                const secretName = isArn ? secretValueResponse.name : secretId;
                const injectedSecrets = injectSecret(secretName, secretAlias, secretValueResponse.secretValue, {
                    overwriteMode,
                    parseJsonSecrets,
                    publicEnvVars,
                    publicNumerics,
                    publicValues,
                    outputFile
                });
                secretsToCleanup = [...secretsToCleanup, ...injectedSecrets];
            } catch (err) {
                // Fail action for any error
                core.setFailed(`Failed to fetch secret: '${secretId}'. Reason: ${err}`);
            }
        }

        // Export the names of variables to clean up after completion
        core.exportVariable(CLEANUP_NAME, JSON.stringify(secretsToCleanup));

        core.info("Completed adding secrets.");
    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message)
    }
}

run();
