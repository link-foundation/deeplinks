import Debug from 'debug';

import { generateApolloClient } from '@deep-foundation/hasura/client';
import { HasuraApi } from "@deep-foundation/hasura/api";
// import { sql } from '@deep-foundation/hasura/sql';
import { gql } from 'apollo-boost';
import vm from 'vm';

import { permissions } from '../permission';
import { findPromiseLink, reject, resolve } from '../promise';
import { DeepClient } from '../client';
import { ALLOWED_IDS, DENIED_IDS } from '../global-ids';
import { execSync } from 'child_process';
import { ContainerController } from '../runner-controller';

const SCHEMA = 'public';

const debug = Debug('deeplinks:eh:links');

// const DEEPLINKS_URL = process.env.DEEPLINKS_URL || 'http://localhost:3006';

const  HASURA_DEEPLINKS_URL = process.env.HASURA_DEEPLINKS_URL || 'http://docker.host.internal:3006';
const DOCKER = process.env.DOCKER || 0;

export const api = new HasuraApi({
  path: process.env.DEEPLINKS_HASURA_PATH,
  ssl: !!+process.env.DEEPLINKS_HASURA_SSL,
  secret: process.env.DEEPLINKS_HASURA_SECRET,
});

const client = generateApolloClient({
  path: `${process.env.DEEPLINKS_HASURA_PATH}/v1/graphql`,
  ssl: !!+process.env.DEEPLINKS_HASURA_SSL,
  secret: process.env.DEEPLINKS_HASURA_SECRET,
});

const deep = new DeepClient({
  apolloClient: client,
})

export function makePromiseResult(promise: any, resolvedTypeId: number, promiseResultTypeId: number, result: any, promiseReasonTypeId: number, handleInsertId: any): Partial<{ from: { data: { from_id: any; type_id: number; to: { data: { type_id: number; object: { data: { value: any; }; }; }; }; }; }; type_id: number; to_id: any; }> {
  return {
    from: {
      data: {
        from_id: promise.id,
        type_id: resolvedTypeId,
        to: {
          data: {
            type_id: promiseResultTypeId,
            object: { data: { value: result } },
          }
        }
      }
    },
    type_id: promiseReasonTypeId,
    to_id: handleInsertId
  };
};

const containerController = new ContainerController({
  gqlURN: DOCKER ? 'deep_deeplinks_1:3006/gql' : 'deep_graphql-engine_1:8080/v1/graphql',
  network: 'deep_network',
  portsHash: {},
  handlersHash: {}
})

export const useRunner = async ({
  code, handler, oldLink, newLink, moment, promiseId,
} : {
  code: string, handler: string, oldLink?: any, newLink?: any, moment?: any; promiseId?: number;
}) => {
  // code example '() => { return (arg)=>{console.log(arg); return {result: 123}}}'
  debug("handler4: ");
  const jwt = (await deep.jwt({ linkId: await deep.id('@deep-foundation/core', 'system', 'admin') })).token;
  debug('jwt', jwt);
  const container = await containerController.newContainer({ publish: false, forceRestart: true, handler, code, jwt, data: { oldLink, newLink, moment }});
  debug('portResult', container);
  const initResult = await containerController.initHandler(container);
  debug('initResult', initResult);
  const callResult = await containerController.callHandler({ code, container, jwt, data: { oldLink, newLink, moment, promiseId } });
  debug('callResult', callResult);
  return callResult;
}

export const handlerOperations = {
  Insert: 'HandleInsert',
  Update: 'HandleUpdate',
  Delete: 'HandleDelete',
};

export async function handleOperation(operation: keyof typeof handlerOperations, oldLink: any, newLink: any) {
  const current = newLink ?? oldLink;
  const currentLinkId = current.id;
  const currentTypeId = current.type_id; // TODO: check if it is correct for type for update

  // console.log('currentLinkId', currentLinkId);
  // console.log('currentTypeId', currentTypeId);

  const handlerTypeId = await deep.id('@deep-foundation/core', 'Handler');
  const handleOperationTypeId = await deep.id('@deep-foundation/core', handlerOperations[operation]);
  const dockerSupportsJsType = await deep.id('@deep-foundation/core', 'dockerSupportsJs');

  // console.log('handlerTypeId', handlerTypeId);
  // console.log('handleOperationTypeId', handleOperationTypeId);

  const queryString = `query SELECT_CODE($typeId: bigint) { links(where: {
          type_id: { _eq: ${await deep.id('@deep-foundation/core', 'SyncTextFile')} },
          in: {
            from_id: { _eq: ${dockerSupportsJsType} },
            type_id: { _eq: ${handlerTypeId} },
            in: {
              from_id: { _eq: $typeId },
              type_id: { _eq: ${handleOperationTypeId} },
            }
          }
        }) {
          id
          value
          in(where: { type_id: { _eq: ${handlerTypeId} } }) {
            id
            in(where: { type_id: { _eq: ${handleOperationTypeId} } }) {
              id
            }
            support: from {
              id
              isolation: from {
                id
                value
              }
            }
          }
        } }`;

        // #{
        //   #  from: {
        //   #    type_id: { _eq: ${await deep.id('@deep-foundation/core', 'Selector')} },
        //   #    out: {
        //   #      type_id: { _eq: ${await deep.id('@deep-foundation/core', 'Include')} },
        //   #      to_id: { _eq: $linkId },
        //   #    }
        //   #  }
        //   #}
  // console.log('queryString', queryString);

  const query = gql`${queryString}`;

  const variables = {
    typeId: currentTypeId
  };
  // console.log('variables', JSON.stringify(variables));

  const handlersResult = await client.query({ query, variables });

  const promises: any[] = [];
  const handleInsertsIds: any[] = [];

  const handlersWithCode = handlersResult?.data?.links as any[];
  // console.log('handlersWithCode.length', handlersWithCode?.length);

  const resolvedTypeId = await deep.id('@deep-foundation/core', 'Resolved');
  const rejectedTypeId = await deep.id('@deep-foundation/core', 'Rejected');
  const promiseResultTypeId = await deep.id('@deep-foundation/core', 'PromiseResult');
  const promiseReasonTypeId = await deep.id('@deep-foundation/core', 'PromiseReason');

  const promise = await findPromiseLink({
    id: currentLinkId, client: deep.apolloClient,
    Then: await deep.id('@deep-foundation/core', 'Then'),
    Promise: await deep.id('@deep-foundation/core', 'Promise'),
    Resolved: resolvedTypeId,
    Rejected: rejectedTypeId,
    Results: false,
  });

  if (handlersWithCode?.length > 0) {
    // console.log(queryString);
    // console.log(query);
    // console.log(JSON.stringify(query, null, 2));
    debug("handlersWithCode: ", JSON.stringify(handlersWithCode, null, 2));
    debug("handlersWithCode?.length: ", handlersWithCode?.length);

    // console.log(handleStringResult);
    // console.log(JSON.stringify(handleStringResult, null, 2));
    // console.log(handleStringResult?.data?.links?.[0]?.value);
    for (const handlerWithCode of handlersWithCode) {
      const code = handlerWithCode?.value?.value;
      const isolationValue = handlerWithCode?.in?.[0]?.support?.isolation?.value?.value;
      const handleInsertId = handlerWithCode?.in?.[0]?.in?.[0].id;
      if (code) {
        try {
          promises.push(async () => useRunner({ code, handler: isolationValue, oldLink, newLink, promiseId: promise.id }));
          handleInsertsIds.push(handleInsertId);
        } catch (error) {
          debug('error', error);
        }
      }
    }

    debug('promise: ', promise);
    if (promise) {
      debug("promises.length: ", promises.length);

      // Promise.allSettled([...promises, Promise.reject(new Error('an error'))])
      // Promise.allSettled(promises)
      await Promise.allSettled(promises.map((p) => p() as Promise<any>))
        .then(async (values) => {
          debug("values: ", values);
          const promiseResults = [];
          for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const handleInsertId = handleInsertsIds[i];
            if (value.status == 'fulfilled') {
              const result = value.value;
              debug("result: ", result);
              const promiseResult = makePromiseResult(promise, resolvedTypeId, promiseResultTypeId, result, promiseReasonTypeId, handleInsertId);
              promiseResults.push(promiseResult);
            }
            if (value.status == 'rejected') {
              const error = value.reason;
              debug("error: ", error);
              const promiseResult = makePromiseResult(promise, rejectedTypeId, promiseResultTypeId, error, promiseReasonTypeId, handleInsertId);
              promiseResults.push(promiseResult);
            }
          }
          try
          {
            await deep.insert(promiseResults, { name: 'IMPORT_PROMISES_RESULTS' });
            debug("inserted promiseResults: ", JSON.stringify(promiseResults, null, 2));
          }
          catch(e)
          {
            debug('promiseResults insert error: ', e?.message ?? e);
          }
        });
    }
  }
}

export async function handleSchedule(handleScheduleLink: any, operation: 'INSERT' | 'DELETE') {
  debug('handleScheduleLink', handleScheduleLink);
  debug('operation', operation);
  if (operation == 'INSERT') {
    // get schedule
    const schedule = await deep.select({
      type_id: await deep.id('@deep-foundation/core', 'Schedule'),
      out: {
        id: { _eq: handleScheduleLink.id },
      },
    }, {
      table: 'links',
      returning: 'id value',
    });
    debug(schedule);
    const scheduleId = schedule?.data?.[0]?.id;
    const scheduleValue = schedule?.data?.[0]?.value.value;
    debug('scheduleId', scheduleId);
    debug('scheduleValue', scheduleValue);
    await api.query({
      type: 'create_cron_trigger',
      args: {
        name: `handle_schedule_${handleScheduleLink?.id}`,
        webhook: `${HASURA_DEEPLINKS_URL}/api/scheduler`,
        schedule: scheduleValue,
        include_in_metadata: true,
        payload: {
          scheduleId,
          schedule: scheduleValue,
          handleScheduleLinkId: handleScheduleLink?.id,
        },
        retry_conf: {
          num_retries: 3,
          timeout_seconds: 120,
          tolerance_seconds: 21675,
          retry_interval_seconds: 12
        },
        comment: `Event trigger for handle schedule link ${handleScheduleLink?.id} with cron schedule definition ${scheduleValue} of ${scheduleId} schedule.`,
      }
    });
    debug('cron trigger created');
  } else if (operation == 'DELETE') {
    await api.query({
      type: 'delete_cron_trigger',
      args: {
        name: `handle_schedule_${handleScheduleLink?.id}`,
      }
    });
    debug('cron trigger deleted');
  }
}

export async function handlePort(handlePortLink: any, operation: 'INSERT' | 'DELETE') {
  console.log('handlePortLink', handlePortLink);
  console.log('operation', operation);

  // get port
  const port = await deep.select({
    id: { _eq: handlePortLink.from_id },
  }, {
    table: 'links',
    returning: 'id value',
  });
  console.log(port);
  const portId = port?.data?.[0]?.id;
  const portValue = port?.data?.[0]?.value.value;
  console.log('portId', portId);
  console.log('portValue', portValue);

  if (operation == 'INSERT') {
    // get dockerImage from isolation provider
    const isolationProvider = await deep.select({
      type_id: await deep.id('@deep-foundation/core', 'DockerIsolationProvider'),
      in: {
        id: { _eq: handlePortLink.id },
      },
    }, {
      table: 'links',
      returning: 'id value',
    });
    console.log(isolationProvider);
    const dockerImage = isolationProvider?.data?.[0]?.value.value;
    console.log('dockerImage', dockerImage);

    // start container
    const containerName = `handle_port_${portValue}`;
    console.log('containerName', containerName);
    // const dockerCommand = `docker run -p ${portValue}:${portValue} --name ${containerName} -d ${dockerImage}`;
    // console.log('dockerCommand', dockerCommand);
    // const dockerOutput = await execSync(dockerCommand).toString();
    // console.log('dockerOutput', dockerOutput);

    const container = await containerController.newContainer({ publish: true, forcePort: portValue, forceName: containerName, handler: dockerImage, code: null, jwt: null, data: { }});

    if (container.error) return console.log('portResult.error', container.error);
    console.log(`port handler container ${JSON.stringify(container)} created`);
  } else if (operation == 'DELETE') {

    // docker stop ${containerName} && docker rm ${containerName}
    const containerName = `handle_port_${portValue}`;
    console.log('containerName', containerName);
    // const dockerCommand = `docker stop ${containerName} && docker rm ${containerName}`;
    // console.log('dockerCommand', dockerCommand);
    // const dockerOutput = await execSync(dockerCommand).toString();
    // console.log('dockerOutput', dockerOutput);

    const container = await containerController.findContainer(containerName);

    await containerController.dropContainer(container);
    
    console.log('port handler container deleted');
  }
}

export default async (req, res) => {
  try {
    const event = req?.body?.event;
    const operation = event?.op;
    if (operation === 'INSERT' || operation === 'UPDATE' || operation === 'DELETE') {
      const oldRow = event?.data?.old;
      const newRow = event?.data?.new;

      // select value into oldRow
      if(oldRow) {
        const queryResult = await deep.select({
          id: { _eq: oldRow.id },
        }, {
          returning: `value`,
        });
        // console.log("old queryResult: ", queryResult);
        oldRow.value = queryResult.data?.[0]?.value;
      }
      // select value into newRow
      if(newRow) {
        const queryResult = await deep.select({
          id: { _eq: newRow.id },
        }, {
          returning: `value`,
        });
        // console.log("new queryResult: ", queryResult);
        newRow.value = queryResult.data?.[0]?.value;
      }

      debug('event', JSON.stringify(event, null, 2));
      debug('oldRow', oldRow);
      debug('newRow', newRow);

      const current = operation === 'DELETE' ? oldRow : newRow;
      const typeId = current.type_id;
      // console.log('current', current, typeId);

      try {
        if(operation === 'INSERT') {
          await handleOperation('Insert', oldRow, newRow);
        } else if(operation === 'UPDATE') {
          // await handleInsert(typeId, newRow);
        } else if(operation === 'DELETE') {
          await handleOperation('Delete', oldRow, newRow);
        }

        const handleScheduleId = await deep.id('@deep-foundation/core', 'HandleSchedule');
        if (typeId === handleScheduleId && (operation === 'INSERT' || operation === 'DELETE')) {
          await handleSchedule(current, operation);
        }

        const handlePortId = await deep.id('@deep-foundation/core', 'HandlePort');
        if (typeId === handlePortId && (operation === 'INSERT' || operation === 'DELETE')) {
          await handlePort(current, operation);
        }

        // console.log("done");

        if (operation === 'INSERT' && !DENIED_IDS.includes(current.type_id) && ALLOWED_IDS.includes(current.type_id)) {
          debug('resolve', current.id);
          await resolve({
            id: current.id, client,
            Then: await deep.id('@deep-foundation/core', 'Then'),
            Promise: await deep.id('@deep-foundation/core', 'Promise'),
            Resolved: await deep.id('@deep-foundation/core', 'Resolved'),
            Rejected: await deep.id('@deep-foundation/core', 'Rejected'),
            Results: false,
          });
        }
        return res.status(200).json({});
      } catch(error) {
        debug('error', error);
        if (operation === 'INSERT' && !DENIED_IDS.includes(current.type_id) && ALLOWED_IDS.includes(current.type_id)) {
          debug('reject', current.id);
          await reject({
            id: current.id, client,
            Then: await deep.id('@deep-foundation/core', 'Then'),
            Promise: await deep.id('@deep-foundation/core', 'Promise'),
            Resolved: await deep.id('@deep-foundation/core', 'Resolved'),
            Rejected: await deep.id('@deep-foundation/core', 'Rejected'),
            Results: false,
          });
        }
      }

      return res.status(500).json({ error: 'notexplained' });
    }
    return res.status(500).json({ error: 'operation can be only INSERT or UPDATE' });
  } catch(error) {
    return res.status(500).json({ error: error.toString() });
  }
};
