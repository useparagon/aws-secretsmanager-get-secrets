import * as core from '@actions/core'
import * as fs from 'fs';
import { mockClient } from "aws-sdk-client-mock";
import {
    GetSecretValueCommand, ListSecretsCommand,
    SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { run } from "../src";
import { CLEANUP_NAME } from "../src/constants";

const DEFAULT_TEST_ENV = {
    AWS_DEFAULT_REGION: 'us-east-1'
};

const smMockClient = mockClient(SecretsManagerClient);

const TEST_NAME = "test/*";

const TEST_NAME_1 = "test/one";
const SECRET_1 = '{"user": "admin", "password": "adminpw"}';

const TEST_NAME_2 = "test/two";
const SECRET_2 = '{"user": "integ", "password": "integpw"}';

const TEST_NAME_3 = "app/secret";
const ENV_NAME_3 = "SECRET_ALIAS";
const SECRET_3 = "secretString1";
const TEST_INPUT_3 = ENV_NAME_3 + "," + TEST_NAME_3;

const TEST_ARN_1 = 'arn:aws:secretsmanager:ap-south-1:123456789000:secret:test2-aBcdef';
const TEST_NAME_4 = 'arn/secret-name';
const ENV_NAME_4 = 'ARN_ALIAS';
const SECRET_4 = "secretString2";
const TEST_ARN_INPUT = ENV_NAME_4 + "," + TEST_ARN_1;

const TEST_FILE = '.env-output-file';

// Mock the inputs for Github action
jest.mock('@actions/core', () => {
    return {
        getMultilineInput: jest.fn((name: string, options?: core.InputOptions) => [TEST_NAME, TEST_INPUT_3, TEST_ARN_INPUT]),
        getBooleanInput: jest.fn((name: string, options?: core.InputOptions) => true),
        getInput: jest.fn((name: string, options?: core.InputOptions) => name === 'output-file' ? TEST_FILE : ''),
        setFailed: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        exportVariable: jest.fn((name: string, val: string) => process.env[name] = val),
        setSecret: jest.fn(),
    };
});

// Mock the fs commands
jest.mock('fs', () => {
    const actualFs = jest.requireActual('fs');
    return {
        ...actualFs,
        appendFileSync: jest.fn((path, data) => { }),
        existsSync: jest.fn((path) => true),
        truncateSync: jest.fn((path, len) => { }),
    };
});

describe('Test main action', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        smMockClient.reset();
        process.env = { ...OLD_ENV, ...DEFAULT_TEST_ENV };
    });

    afterEach(() => {
        process.env = OLD_ENV;
    });

    test('Retrieves and sets the requested secrets as environment variables, parsing JSON', async () => {
        // Mock all Secrets Manager calls
        smMockClient
            .on(GetSecretValueCommand, { SecretId: TEST_NAME_1 })
            .resolves({ Name: TEST_NAME_1, SecretString: SECRET_1 })
            .on(GetSecretValueCommand, { SecretId: TEST_NAME_2 })
            .resolves({ Name: TEST_NAME_2, SecretString: SECRET_2 })
            .on(GetSecretValueCommand, { SecretId: TEST_NAME_3 })
            .resolves({ Name: TEST_NAME_3, SecretString: SECRET_3 })
            .on(GetSecretValueCommand, { // Retrieve arn secret
                SecretId: TEST_ARN_1,
            })
            .resolves({
                Name: TEST_NAME_4,
                SecretString: SECRET_4
            })
            .on(ListSecretsCommand)
            .resolves({
                SecretList: [
                    {
                        Name: TEST_NAME_1
                    },
                    {
                        Name: TEST_NAME_2
                    }
                ]
            });

        await run();
        expect(core.exportVariable).toHaveBeenCalledTimes(7);
        expect(core.setFailed).not.toHaveBeenCalled();

        // JSON secrets should be parsed
        expect(core.exportVariable).toHaveBeenCalledWith('TEST_ONE_USER', 'admin');
        expect(core.exportVariable).toHaveBeenCalledWith('TEST_ONE_PASSWORD', 'adminpw');
        expect(core.exportVariable).toHaveBeenCalledWith('TEST_TWO_USER', 'integ');
        expect(core.exportVariable).toHaveBeenCalledWith('TEST_TWO_PASSWORD', 'integpw');

        expect(core.exportVariable).toHaveBeenCalledWith(ENV_NAME_3, SECRET_3);
        expect(core.exportVariable).toHaveBeenCalledWith(ENV_NAME_4, SECRET_4);

        expect(core.exportVariable).toHaveBeenCalledWith(CLEANUP_NAME, JSON.stringify(['TEST_ONE_USER', 'TEST_ONE_PASSWORD', 'TEST_TWO_USER', 'TEST_TWO_PASSWORD', ENV_NAME_3, ENV_NAME_4]));
    });

    describe('Support prefixing JSON', () => {
        test('Allow custom prefix', async () => {
            const secretId = 'test/one';
            const secretString: string = JSON.stringify({
                "key1": "value1",
                "key2": "value2"
            });

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce([`CUSTOM,${secretId}`]);
            jest.spyOn(core, 'getBooleanInput').mockReturnValueOnce(true);

            smMockClient
                .on(GetSecretValueCommand, { SecretId: secretId })
                .resolves({ Name: secretId, SecretString: secretString });

            await run();

            expect(core.exportVariable).toHaveBeenCalledTimes(3);

            expect(core.exportVariable).toHaveBeenCalledWith('CUSTOM_KEY1', 'value1');
            expect(core.exportVariable).toHaveBeenCalledWith('CUSTOM_KEY2', 'value2');
            expect(core.exportVariable).toHaveBeenCalledWith(CLEANUP_NAME, JSON.stringify(['CUSTOM_KEY1', 'CUSTOM_KEY2']));
        })

        test('Allow for no prefix', async () => {
            const secretId = 'test/one';
            const secretString: string = JSON.stringify({
                "key1": "value1",
                "key2": "value2"
            });

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce([`,${secretId}`]);
            jest.spyOn(core, 'getBooleanInput').mockReturnValueOnce(true);

            smMockClient
                .on(GetSecretValueCommand, { SecretId: secretId })
                .resolves({ Name: secretId, SecretString: secretString });

            await run();

            // expect(core.exportVariable).toHaveBeenCalledTimes(3);

            expect(core.exportVariable).toHaveBeenCalledWith('KEY1', 'value1');
            expect(core.exportVariable).toHaveBeenCalledWith('KEY2', 'value2');
            expect(core.exportVariable).toHaveBeenCalledWith(CLEANUP_NAME, JSON.stringify(['KEY1', 'KEY2']));
        })
    })

    test('Fails the action when an error occurs in Secrets Manager', async () => {
        smMockClient.onAnyCommand().resolves({});

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(1);
    });

    describe('overwrite-mode', () => {
        test('default - fails the action when multiple secrets exported the same variable name', async () => {
            smMockClient
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_1 })
                .resolves({ Name: TEST_NAME_1, SecretString: SECRET_1 })
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_2 })
                .on(GetSecretValueCommand, { // Retrieve arn secret
                    SecretId: TEST_ARN_1,
                })
                .resolves({
                    Name: TEST_NAME_4,
                    SecretString: SECRET_4
                })
                .on(GetSecretValueCommand) // default
                .resolves({ Name: "DefaultName", SecretString: "Default" })
                .on(ListSecretsCommand)
                .resolves({
                    SecretList: [
                        {
                            Name: "TEST/SECRET/2"
                        },
                        {
                            Name: "TEST/SECRET@2"
                        }
                    ]
                });

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce([TEST_NAME]);
            jest.spyOn(core, 'getBooleanInput').mockReturnValueOnce(true);
            jest.spyOn(core, 'getInput').mockReturnValueOnce('');

            await run();
            expect(core.setFailed).toHaveBeenCalledTimes(1);
            expect(core.setFailed)
                .toHaveBeenCalledWith("Failed to fetch secret: 'TEST/SECRET@2'. Reason: Error: The environment name 'TEST_SECRET_2' is already in use. Please use an alias to ensure that each secret has a unique environment name.");
        });

        test('error - fails the action when multiple secrets exported the same variable name', async () => {
            smMockClient
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_1 })
                .resolves({ Name: TEST_NAME_1, SecretString: SECRET_1 })
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_2 })
                .on(GetSecretValueCommand, { // Retrieve arn secret
                    SecretId: TEST_ARN_1,
                })
                .resolves({
                    Name: TEST_NAME_4,
                    SecretString: SECRET_4
                })
                .on(GetSecretValueCommand) // default
                .resolves({ Name: "DefaultName", SecretString: "Default" })
                .on(ListSecretsCommand)
                .resolves({
                    SecretList: [
                        {
                            Name: "TEST/SECRET/2"
                        },
                        {
                            Name: "TEST/SECRET@2"
                        }
                    ]
                });

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce([TEST_NAME]);
            jest.spyOn(core, 'getBooleanInput').mockReturnValueOnce(true);
            jest.spyOn(core, 'getInput').mockReturnValueOnce('error');

            await run();
            expect(core.setFailed).toHaveBeenCalledTimes(1);
            expect(core.setFailed)
                .toHaveBeenCalledWith("Failed to fetch secret: 'TEST/SECRET@2'. Reason: Error: The environment name 'TEST_SECRET_2' is already in use. Please use an alias to ensure that each secret has a unique environment name.");
        });

        test('warn - warns when multiple secrets exported the same variable name', async () => {
            smMockClient
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_1 })
                .resolves({ Name: TEST_NAME_1, SecretString: SECRET_1 })
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_2 })
                .on(GetSecretValueCommand, { // Retrieve arn secret
                    SecretId: TEST_ARN_1,
                })
                .resolves({
                    Name: TEST_NAME_4,
                    SecretString: SECRET_4
                })
                .on(GetSecretValueCommand) // default
                .resolves({ Name: "DefaultName", SecretString: "Default" })
                .on(ListSecretsCommand)
                .resolves({
                    SecretList: [
                        {
                            Name: "TEST/SECRET/2"
                        },
                        {
                            Name: "TEST/SECRET@2"
                        }
                    ]
                });

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce([TEST_NAME]);
            jest.spyOn(core, 'getBooleanInput').mockReturnValueOnce(true);
            jest.spyOn(core, 'getInput').mockReturnValueOnce('warn');

            await run();
            expect(core.setFailed).not.toHaveBeenCalled();
            expect(core.warning)
                .toHaveBeenCalledWith("The environment name 'TEST_SECRET_2' is already in use. The value will be overwritten.");
        });

        test('silent - warns when multiple secrets exported the same variable name', async () => {
            smMockClient
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_1 })
                .resolves({ Name: TEST_NAME_1, SecretString: SECRET_1 })
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_2 })
                .on(GetSecretValueCommand, { // Retrieve arn secret
                    SecretId: TEST_ARN_1,
                })
                .resolves({
                    Name: TEST_NAME_4,
                    SecretString: SECRET_4
                })
                .on(GetSecretValueCommand) // default
                .resolves({ Name: "DefaultName", SecretString: "Default" })
                .on(ListSecretsCommand)
                .resolves({
                    SecretList: [
                        {
                            Name: "TEST/SECRET/2"
                        },
                        {
                            Name: "TEST/SECRET@2"
                        }
                    ]
                });

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce([TEST_NAME]);
            jest.spyOn(core, 'getBooleanInput').mockReturnValueOnce(true);
            jest.spyOn(core, 'getInput').mockReturnValueOnce('silent');

            await run();
            expect(core.setFailed).not.toHaveBeenCalled();
            expect(core.warning).not.toHaveBeenCalled();
        });
    })

    describe('public-numerics', () => {
        test('false - calls setSecret on numeric values', async () => {
            smMockClient
                .on(GetSecretValueCommand, { SecretId: 'numeric_secret' })
                .resolves({ Name: 'numeric_secret', SecretString: '1234' })

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce(['numeric_secret']);
            jest.spyOn(core, 'getBooleanInput').mockImplementation((option: string) => {
                switch (option) {
                    case 'parse-json-secrets':
                        return true;
                    case 'public-numerics':
                        return false;
                    default:
                        return false;
                }
            });
            jest.spyOn(core, 'getInput').mockReturnValueOnce('');

            await run();
            expect(core.setFailed).not.toHaveBeenCalled();
            expect(core.setSecret).toHaveBeenCalled();
        })

        test.each(['0', '1', '123'])('true - does not call setSecret on numeric values: %s', async (secretValue: string) => {
            smMockClient
                .on(GetSecretValueCommand, { SecretId: 'numeric_secret' })
                .resolves({ Name: 'numeric_secret', SecretString: secretValue })

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce(['numeric_secret']);
            jest.spyOn(core, 'getBooleanInput').mockImplementation((option: string) => {
                switch (option) {
                    case 'parse-json-secrets':
                        return true;
                    case 'public-numerics':
                        return true;
                    default:
                        return false;
                }
            });
            jest.spyOn(core, 'getInput').mockReturnValueOnce('');

            await run();
            expect(core.setFailed).not.toHaveBeenCalled();
            expect(core.setSecret).not.toHaveBeenCalled();
        })


        test.each(['string', 'false', '123abc', 'abc123', 'a1b2c'])('true - calls setSecret on non-numeric values: %s', async (secretValue: string) => {
            smMockClient
                .on(GetSecretValueCommand, { SecretId: 'numeric_secret' })
                .resolves({ Name: 'numeric_secret', SecretString: secretValue })

            jest.spyOn(core, 'getMultilineInput').mockReturnValueOnce(['numeric_secret']);
            jest.spyOn(core, 'getBooleanInput').mockImplementation((option: string) => {
                switch (option) {
                    case 'parse-json-secrets':
                        return true;
                    case 'public-numerics':
                        return true;
                    default:
                        return false;
                }
            });
            jest.spyOn(core, 'getInput').mockReturnValueOnce('');

            await run();
            expect(core.setFailed).not.toHaveBeenCalled();
            expect(core.setSecret).toHaveBeenCalledWith(secretValue);
        })
    })

    describe('public-env-vars', () => {
        test('does not call setSecret for provided env vars', async () => {
            // Mock all Secrets Manager calls
            smMockClient
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_1 })
                .resolves({ Name: TEST_NAME_1, SecretString: SECRET_1 })
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_2 })
                .resolves({ Name: TEST_NAME_2, SecretString: SECRET_2 })
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_3 })
                .resolves({ Name: TEST_NAME_3, SecretString: SECRET_3 })
                .on(GetSecretValueCommand, { // Retrieve arn secret
                    SecretId: TEST_ARN_1,
                })
                .resolves({
                    Name: TEST_NAME_4,
                    SecretString: SECRET_4
                })
                .on(ListSecretsCommand)
                .resolves({
                    SecretList: [
                        {
                            Name: TEST_NAME_1
                        },
                        {
                            Name: TEST_NAME_2
                        }
                    ]
                });

            jest.spyOn(core, 'getMultilineInput').mockImplementation((option: string) => {
                switch (option) {
                    case 'secret-ids':
                        return [TEST_NAME, TEST_INPUT_3, TEST_ARN_INPUT];
                    case 'public-env-vars':
                        return ['TEST_ONE_USER', 'TEST_TWO_USER'];
                    default:
                        return [];
                }
            });
            jest.spyOn(core, 'getBooleanInput').mockReturnValueOnce(true);
            jest.spyOn(core, 'getInput').mockReturnValueOnce('');

            await run();
            expect(core.setFailed).not.toHaveBeenCalled();
            expect(core.exportVariable).toHaveBeenCalledTimes(7);

            expect(core.exportVariable).toHaveBeenCalledWith('TEST_ONE_USER', 'admin');
            expect(core.exportVariable).toHaveBeenCalledWith('TEST_ONE_PASSWORD', 'adminpw');
            expect(core.exportVariable).toHaveBeenCalledWith('TEST_TWO_USER', 'integ');
            expect(core.exportVariable).toHaveBeenCalledWith('TEST_TWO_PASSWORD', 'integpw');

            expect(core.setSecret).not.toHaveBeenCalledWith('admin');
            expect(core.setSecret).toHaveBeenCalledWith('adminpw');
            expect(core.setSecret).not.toHaveBeenCalledWith('integ');
            expect(core.setSecret).toHaveBeenCalledWith('integpw');
        })
    })

    describe('public-values', () => {
        test('does not call setSecret for provided env var values', async () => {
            // Mock all Secrets Manager calls
            smMockClient
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_1 })
                .resolves({ Name: TEST_NAME_1, SecretString: SECRET_1 })
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_2 })
                .resolves({ Name: TEST_NAME_2, SecretString: SECRET_2 })
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_3 })
                .resolves({ Name: TEST_NAME_3, SecretString: SECRET_3 })
                .on(GetSecretValueCommand, { // Retrieve arn secret
                    SecretId: TEST_ARN_1,
                })
                .resolves({
                    Name: TEST_NAME_4,
                    SecretString: SECRET_4
                })
                .on(ListSecretsCommand)
                .resolves({
                    SecretList: [
                        {
                            Name: TEST_NAME_1
                        },
                        {
                            Name: TEST_NAME_2
                        }
                    ]
                });

            jest.spyOn(core, 'getMultilineInput').mockImplementation((option: string) => {
                switch (option) {
                    case 'secret-ids':
                        return [TEST_NAME, TEST_INPUT_3, TEST_ARN_INPUT];
                    case 'public-env-vars':
                        return [];
                    case 'public-values':
                        return ['admin', 'integ'];
                    default:
                        return [];
                }
            });
            jest.spyOn(core, 'getBooleanInput').mockReturnValueOnce(true);
            jest.spyOn(core, 'getInput').mockReturnValueOnce('');

            await run();
            expect(core.setFailed).not.toHaveBeenCalled();
            expect(core.exportVariable).toHaveBeenCalledTimes(7);

            expect(core.exportVariable).toHaveBeenCalledWith('TEST_ONE_USER', 'admin');
            expect(core.exportVariable).toHaveBeenCalledWith('TEST_ONE_PASSWORD', 'adminpw');
            expect(core.exportVariable).toHaveBeenCalledWith('TEST_TWO_USER', 'integ');
            expect(core.exportVariable).toHaveBeenCalledWith('TEST_TWO_PASSWORD', 'integpw');

            expect(core.setSecret).not.toHaveBeenCalledWith('admin');
            expect(core.setSecret).toHaveBeenCalledWith('adminpw');
            expect(core.setSecret).not.toHaveBeenCalledWith('integ');
            expect(core.setSecret).toHaveBeenCalledWith('integpw');
        })
    })

    describe('output-file', () => {
        test('Appending secrets to file', async () => {
            // Mock all Secrets Manager calls
            smMockClient
                .on(GetSecretValueCommand, { SecretId: TEST_NAME_1 })
                .resolves({ Name: TEST_NAME_1, SecretString: SECRET_1 })
                .on(ListSecretsCommand)
                .resolves({
                    SecretList: [
                        {
                            Name: TEST_NAME_1
                        }
                    ]
                });

            await run();

            expect(fs.existsSync).toHaveBeenCalledWith(TEST_FILE);
            expect(fs.truncateSync).toHaveBeenCalled();
            expect(fs.appendFileSync).toHaveBeenCalledWith(TEST_FILE, 'TEST_ONE_USER=admin\n');
            expect(fs.appendFileSync).toHaveBeenCalledWith(TEST_FILE, 'TEST_ONE_PASSWORD=adminpw\n');
        })
    })
});
