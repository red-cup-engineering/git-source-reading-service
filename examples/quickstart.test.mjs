import assert from 'node:assert/strict';
import test from 'node:test';
import {gitExtractionPlan} from "@red-cup-engineering/git-source-reading-service/git-command-codec";

test("GIT-SOURCE-READING-SERVICE-QUICKSTART",()=>{
 assert.deepEqual(gitExtractionPlan.rewriteMappings([{from:'subject'}]).arguments,['filter-repo','--force','--quiet','--path','subject/','--path-rename','subject/:']);
});
