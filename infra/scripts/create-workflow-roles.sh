#!/usr/bin/env bash
#
# Creates the IAM roles the investigation workflow needs.
#
# Separate from the SAM stack because an AWS PowerUserAccess profile cannot
# call iam:CreateRole, so these are created once by a principal that can, and
# passed into the stack as parameters.
#
# Every policy is scoped to named resources. There are no wildcards on
# resources that matter, and no role can read a secret it does not need.
#
# Usage: create-workflow-roles.sh [stage]
set -euo pipefail

STAGE="${1:-prod}"
PROFILE="${AWS_PROFILE:-netra}"
REGION="${AWS_REGION:-eu-north-1}"
ACCOUNT="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"

TABLE="arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/netra-${STAGE}-investigations"
GITHUB_SECRET="arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:netra/${STAGE}/github/app-*"
MODEL_SECRET="arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:netra/${STAGE}/model/openrouter-*"
STATE_MACHINE="arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:netra-${STAGE}-investigation"

trust() {
  printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"%s"},"Action":"sts:AssumeRole"}]}' "$1"
}

make_role() {
  local name="$1" service="$2"
  if aws iam get-role --role-name "$name" --profile "$PROFILE" >/dev/null 2>&1; then
    echo "  role $name already exists"
  else
    aws iam create-role --role-name "$name" \
      --assume-role-policy-document "$(trust "$service")" \
      --description "Netra ${STAGE}: $3" \
      --profile "$PROFILE" >/dev/null
    echo "  created $name"
  fi
}

put_policy() {
  aws iam put-role-policy --role-name "$1" --policy-name "$2" \
    --policy-document "$3" --profile "$PROFILE"
  echo "  policy $2 -> $1"
}

echo "Netra ${STAGE} workflow roles in ${REGION} (account ${ACCOUNT})"

# ---------------------------------------------------------------------------
# 1. Lifecycle Lambdas: read and write investigation records, and log.
# ---------------------------------------------------------------------------
make_role "netra-lambda-role" "lambda.amazonaws.com" "investigation lifecycle Lambdas"
aws iam attach-role-policy --role-name netra-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
  --profile "$PROFILE"
put_policy netra-lambda-role netra-investigations-access "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Sid":"InvestigationRecords","Effect":"Allow",
   "Action":["dynamodb:PutItem","dynamodb:GetItem","dynamodb:UpdateItem","dynamodb:Query"],
   "Resource":"${TABLE}"}
]}
JSON
)"

# ---------------------------------------------------------------------------
# 2. ECS agent: pull the image, write logs, resolve the task's secrets.
#    The agent reads the secrets; the container never has permission to.
# ---------------------------------------------------------------------------
make_role "netra-task-execution-role" "ecs-tasks.amazonaws.com" "ECS agent for the investigator task"
aws iam attach-role-policy --role-name netra-task-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
  --profile "$PROFILE"
put_policy netra-task-execution-role netra-task-secrets "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Sid":"InjectTaskSecrets","Effect":"Allow","Action":"secretsmanager:GetSecretValue",
   "Resource":["${GITHUB_SECRET}","${MODEL_SECRET}"]}
]}
JSON
)"

# ---------------------------------------------------------------------------
# 3. The investigator container: write what it establishes, nothing more.
#    Deliberately no secretsmanager access -- its secrets are injected by the
#    agent, so a flaw in the analysis code cannot read them back.
# ---------------------------------------------------------------------------
make_role "netra-task-role" "ecs-tasks.amazonaws.com" "the investigator container itself"
put_policy netra-task-role netra-investigation-writes "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Sid":"WriteInvestigationResults","Effect":"Allow",
   "Action":["dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:GetItem","dynamodb:BatchWriteItem"],
   "Resource":"${TABLE}"}
]}
JSON
)"

# ---------------------------------------------------------------------------
# 4. The state machine: invoke its three Lambdas and run one task definition.
#    The ecs:RunTask permissions that Step Functions' .sync integration needs
#    are the documented minimum.
# ---------------------------------------------------------------------------
make_role "netra-states-role" "states.amazonaws.com" "the investigation state machine"
put_policy netra-states-role netra-workflow "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Sid":"InvokeLifecycleFunctions","Effect":"Allow","Action":"lambda:InvokeFunction",
   "Resource":[
     "arn:aws:lambda:${REGION}:${ACCOUNT}:function:netra-${STAGE}-create-investigation",
     "arn:aws:lambda:${REGION}:${ACCOUNT}:function:netra-${STAGE}-confirm-outcome",
     "arn:aws:lambda:${REGION}:${ACCOUNT}:function:netra-${STAGE}-record-failure"]},
  {"Sid":"RunTheInvestigationTask","Effect":"Allow","Action":["ecs:RunTask"],
   "Resource":"arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/netra-${STAGE}-investigator:*",
   "Condition":{"ArnEquals":{"ecs:cluster":"arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/netra-${STAGE}"}}},
  {"Sid":"ManageTheRunningTask","Effect":"Allow","Action":["ecs:StopTask","ecs:DescribeTasks"],
   "Resource":"arn:aws:ecs:${REGION}:${ACCOUNT}:task/netra-${STAGE}/*"},
  {"Sid":"PassTheTaskRoles","Effect":"Allow","Action":"iam:PassRole",
   "Resource":["arn:aws:iam::${ACCOUNT}:role/netra-task-role",
               "arn:aws:iam::${ACCOUNT}:role/netra-task-execution-role"],
   "Condition":{"StringEquals":{"iam:PassedToService":"ecs-tasks.amazonaws.com"}}},
  {"Sid":"SyncIntegrationCallbacks","Effect":"Allow",
   "Action":["events:PutTargets","events:PutRule","events:DescribeRule"],
   "Resource":"arn:aws:events:${REGION}:${ACCOUNT}:rule/StepFunctionsGetEventsForECSTaskRule"},
  {"Sid":"WorkflowLogging","Effect":"Allow",
   "Action":["logs:CreateLogDelivery","logs:GetLogDelivery","logs:UpdateLogDelivery",
             "logs:DeleteLogDelivery","logs:ListLogDeliveries","logs:PutResourcePolicy",
             "logs:DescribeResourcePolicies","logs:DescribeLogGroups"],
   "Resource":"*"},
  {"Sid":"Tracing","Effect":"Allow",
   "Action":["xray:PutTraceSegments","xray:PutTelemetryRecords",
             "xray:GetSamplingRules","xray:GetSamplingTargets"],
   "Resource":"*"}
]}
JSON
)"

# ---------------------------------------------------------------------------
# 5. EventBridge: start exactly one state machine.
# ---------------------------------------------------------------------------
make_role "netra-events-role" "events.amazonaws.com" "EventBridge starting the workflow"
put_policy netra-events-role netra-start-investigation "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Sid":"StartInvestigation","Effect":"Allow","Action":"states:StartExecution",
   "Resource":"${STATE_MACHINE}"}
]}
JSON
)"

echo
echo "Deploy with:"
echo "  sam deploy --config-env ${STAGE} --parameter-overrides \\"
echo "    Stage=${STAGE} \\"
echo "    ExecutionRoleArn=arn:aws:iam::${ACCOUNT}:role/netra-webhook-role \\"
echo "    LambdaRoleArn=arn:aws:iam::${ACCOUNT}:role/netra-lambda-role \\"
echo "    StateMachineRoleArn=arn:aws:iam::${ACCOUNT}:role/netra-states-role \\"
echo "    TaskExecutionRoleArn=arn:aws:iam::${ACCOUNT}:role/netra-task-execution-role \\"
echo "    TaskRoleArn=arn:aws:iam::${ACCOUNT}:role/netra-task-role \\"
echo "    EventsRoleArn=arn:aws:iam::${ACCOUNT}:role/netra-events-role"
